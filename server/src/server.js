import express from "express";
import cors from "cors";
import multer from "multer";
import bcrypt from "bcryptjs";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dayjs from "dayjs";
import { all, get, initDb, run } from "./db.js";
import { adminRequired, authRequired, signToken } from "./auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, "..");
/** Pasta `dist` do Vite (projeto pai do /server) — site + API no mesmo processo em produção */
const clientDistDir = path.join(rootDir, "..", "dist");
const uploadsDir = path.join(rootDir, "uploads");
const proofRetentionMonths = Math.max(1, Number(process.env.PROOF_RETENTION_MONTHS) || 3);
const proofCleanupIntervalMs = Math.max(60_000, Number(process.env.PROOF_CLEANUP_INTERVAL_MS) || 24 * 60 * 60 * 1000);

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const app = express();
const PORT = process.env.PORT || 4000;

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);
  },
});
const upload = multer({ storage });

app.use(cors());
app.use(express.json());
app.use("/uploads", express.static(uploadsDir));

function resolveUploadAbsolutePath(fileUrl) {
  if (!fileUrl) return null;
  const relativeFile = String(fileUrl).replace(/^\/+/, "").replace(/^uploads\//, "");
  if (!relativeFile) return null;
  const absolutePath = path.resolve(uploadsDir, relativeFile);
  const uploadsRoot = path.resolve(uploadsDir);
  if (!absolutePath.startsWith(uploadsRoot)) return null;
  return absolutePath;
}

async function deleteUploadByUrl(fileUrl) {
  const absolutePath = resolveUploadAbsolutePath(fileUrl);
  if (!absolutePath) return false;
  try {
    await fs.promises.unlink(absolutePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function cleanupExpiredProofs(now = dayjs()) {
  const cutoff = now.subtract(proofRetentionMonths, "month").toISOString();
  const expiredPayments = await all(
    "SELECT id, proof_file, admin_proof_file FROM payments WHERE datetime(created_at) <= datetime(?) AND (proof_file IS NOT NULL OR admin_proof_file IS NOT NULL)",
    [cutoff]
  );

  let removedFiles = 0;
  for (const payment of expiredPayments) {
    if (await deleteUploadByUrl(payment.proof_file)) removedFiles += 1;
    if (await deleteUploadByUrl(payment.admin_proof_file)) removedFiles += 1;
    await run("UPDATE payments SET proof_file = NULL, admin_proof_file = NULL WHERE id = ?", [payment.id]);
  }

  return {
    affectedPayments: expiredPayments.length,
    removedFiles,
  };
}

function monthRefNow() {
  return dayjs().format("YYYY-MM");
}

function monthRefFromDate(dateValue) {
  return dayjs(dateValue).format("YYYY-MM");
}

function getNextPaymentWindow(lastPaidAt) {
  if (!lastPaidAt) return null;

  const nextDueAt = dayjs(lastPaidAt).add(1, "month").startOf("day");
  const unlockAt = nextDueAt.subtract(3, "day").startOf("day");

  return {
    referenceMonth: monthRefFromDate(nextDueAt),
    unlockAt: unlockAt.toISOString(),
    nextDueAt: nextDueAt.toISOString(),
  };
}

function getPaymentAvailability({ latestPayment, latestPaidPayment, now = dayjs() }) {
  const nextWindow = latestPaidPayment ? getNextPaymentWindow(latestPaidPayment.created_at) : null;
  const referenceFromWindow = nextWindow?.referenceMonth || monthRefNow();

  if (!latestPayment) {
    return {
      status: "first_payment",
      canSubmit: true,
      referenceMonth: referenceFromWindow,
      nextUnlockAt: null,
      nextDueAt: null,
      lastPaidAt: null,
    };
  }

  if (latestPayment.status === "pending" || latestPayment.status === "draft") {
    return {
      status: "pending_review",
      canSubmit: false,
      referenceMonth: latestPayment.month_ref || referenceFromWindow,
      nextUnlockAt: nextWindow?.unlockAt || null,
      nextDueAt: nextWindow?.nextDueAt || null,
      lastPaidAt: latestPaidPayment?.created_at || null,
    };
  }

  if (latestPayment.status === "rejected") {
    return {
      status: "retry_payment",
      canSubmit: true,
      referenceMonth: latestPayment.month_ref || referenceFromWindow,
      nextUnlockAt: nextWindow?.unlockAt || null,
      nextDueAt: nextWindow?.nextDueAt || null,
      lastPaidAt: latestPaidPayment?.created_at || null,
    };
  }

  if (!nextWindow) {
    return {
      status: "first_payment",
      canSubmit: true,
      referenceMonth: referenceFromWindow,
      nextUnlockAt: null,
      nextDueAt: null,
      lastPaidAt: latestPaidPayment?.created_at || null,
    };
  }

  if (now.isBefore(dayjs(nextWindow.unlockAt))) {
    return {
      status: "up_to_date",
      canSubmit: false,
      referenceMonth: nextWindow.referenceMonth,
      nextUnlockAt: nextWindow.unlockAt,
      nextDueAt: nextWindow.nextDueAt,
      lastPaidAt: latestPaidPayment?.created_at || null,
    };
  }

  return {
    status: "payment_available",
    canSubmit: true,
    referenceMonth: nextWindow.referenceMonth,
    nextUnlockAt: nextWindow.unlockAt,
    nextDueAt: nextWindow.nextDueAt,
    lastPaidAt: latestPaidPayment?.created_at || null,
  };
}

function getPlanStatusSummary({ lastPaidAt, now = dayjs() }) {
  if (!lastPaidAt) {
    return {
      nextDueAt: null,
      daysOverdue: 0,
      currentCyclePaid: false,
      planStatus: "pending",
    };
  }

  const dueBase = dayjs(getNextPaymentWindow(lastPaidAt)?.nextDueAt);
  const today = now.startOf("day");
  const daysOverdue = dueBase ? Math.max(0, today.diff(dueBase.startOf("day"), "day")) : 0;
  const currentCyclePaid = Boolean(lastPaidAt) && daysOverdue === 0;
  const planStatus = daysOverdue > 10 ? "inactive" : daysOverdue > 0 ? "late" : "active";

  return {
    nextDueAt: dueBase ? dueBase.toISOString() : null,
    daysOverdue,
    currentCyclePaid,
    planStatus,
  };
}

async function getLatestUserPaymentSnapshot(userId) {
  const latestPayment = await get(
    "SELECT id, month_ref, status, created_at, paid_at FROM payments WHERE user_id = ? ORDER BY datetime(created_at) DESC LIMIT 1",
    [userId]
  );
  const latestPaidPayment = await get(
    "SELECT id, month_ref, status, created_at, paid_at FROM payments WHERE user_id = ? AND status = 'paid' ORDER BY datetime(created_at) DESC LIMIT 1",
    [userId]
  );

  return { latestPayment, latestPaidPayment };
}

async function ensureAdmin() {
  const admin = await get("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (admin) return;

  const hash = await bcrypt.hash("admin123", 10);
  await run(
    "INSERT INTO users (name, email, phone, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'admin', ?)",
    ["Administrador", "admin@esportesce.com", null, hash, new Date().toISOString()]
  );
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !email || !phone || !password) {
      return res.status(400).json({ message: "Preencha nome, e-mail, telefone e senha." });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: "A senha precisa ter no mínimo 6 caracteres." });
    }

    const exists = await get("SELECT id FROM users WHERE email = ?", [email]);
    if (exists) return res.status(409).json({ message: "E-mail já cadastrado." });

    const hash = await bcrypt.hash(password, 10);
    const createdAt = new Date().toISOString();
    const result = await run(
      "INSERT INTO users (name, email, phone, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'user', ?)",
      [name, email, phone, hash, createdAt]
    );

    const token = signToken({ id: result.lastID, name, email, phone, role: "user" });
    return res.status(201).json({ token, user: { id: result.lastID, name, email, phone, role: "user" } });
  } catch (error) {
    return res.status(500).json({ message: "Erro ao registrar", error: error.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await get("SELECT * FROM users WHERE email = ?", [email]);
    if (!user) return res.status(401).json({ message: "Credenciais inválidas." });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ message: "Credenciais inválidas." });

    const payload = { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role };
    return res.json({ token: signToken(payload), user: payload });
  } catch (error) {
    return res.status(500).json({ message: "Erro ao fazer login", error: error.message });
  }
});

app.get("/api/me", authRequired, async (req, res) => {
  const user = await get("SELECT id, name, email, phone, role, created_at FROM users WHERE id = ?", [req.user.id]);
  return res.json(user);
});

app.post("/api/payments", authRequired, upload.single("proof"), async (req, res) => {
  try {
    const { paymentMethod = "pix" } = req.body;
    const dbUser = await get("SELECT name FROM users WHERE id = ?", [req.user.id]);
    const payerName = String(req.user?.name || dbUser?.name || req.body.userName || "").trim();
    const method = paymentMethod === "cash" ? "cash" : "pix";
    if (!payerName) {
      return res.status(400).json({ message: "Informe o nome." });
    }
    if (method === "pix" && !req.file) {
      return res.status(400).json({ message: "Anexe o comprovante (obrigatório para pagamento via PIX)." });
    }

    const numericAmount = 15;
    const pixCode = method === "cash" ? "-" : "621.669.183-01";
    const createdAt = new Date().toISOString();
    const proofFile = req.file ? `/uploads/${req.file.filename}` : null;

    const paymentSnapshot = await getLatestUserPaymentSnapshot(req.user.id);
    const paymentAvailability = getPaymentAvailability(paymentSnapshot);

    if (!paymentAvailability.canSubmit) {
      if (paymentAvailability.status === "pending_review") {
        return res.status(409).json({ message: "Seu pagamento está sendo analisado pelos coordenadores." });
      }
      if (paymentAvailability.status === "up_to_date" && paymentAvailability.nextUnlockAt) {
        return res.status(409).json({
          message: `O pagamento atual já foi realizado. Nova liberação em ${dayjs(paymentAvailability.nextUnlockAt).format("DD/MM/YYYY")}.`,
        });
      }
      return res.status(409).json({ message: "O pagamento ainda não está liberado para este aluno." });
    }

    const reference = paymentAvailability.referenceMonth;
    const existingForReference = await get(
      "SELECT id, status FROM payments WHERE user_id = ? AND month_ref = ? ORDER BY datetime(created_at) DESC LIMIT 1",
      [req.user.id, reference]
    );
    if (existingForReference?.status === "pending" || existingForReference?.status === "draft") {
      return res.status(409).json({ message: "Seu pagamento está sendo analisado pelos coordenadores." });
    }
    if (existingForReference?.status === "paid") {
      return res.status(409).json({ message: "O pagamento atual já foi realizado." });
    }

    const result = await run(
      "INSERT INTO payments (user_id, user_name, amount, month_ref, pix_code, proof_file, payment_method, status, created_at, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      [req.user.id, payerName, numericAmount, reference, pixCode, proofFile, method, createdAt, createdAt]
    );

    return res.status(201).json({
      id: result.lastID,
      pixCode,
      message: "Obrigado, seu pagamento sera analisado!",
    });
  } catch (error) {
    return res.status(500).json({ message: "Erro ao criar pagamento", error: error.message });
  }
});

app.get("/api/payments/my", authRequired, async (req, res) => {
  const rows = await all(
    "SELECT id, user_name, amount, month_ref, status, proof_file, payment_method, created_at, paid_at FROM payments WHERE user_id = ? ORDER BY datetime(created_at) DESC",
    [req.user.id]
  );
  const paymentSnapshot = await getLatestUserPaymentSnapshot(req.user.id);
  const availability = getPaymentAvailability(paymentSnapshot);
  return res.json({ payments: rows, availability });
});

app.post("/api/feedbacks", authRequired, async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();
    if (message.length < 6) {
      return res.status(400).json({ message: "Escreva uma sugestão com pelo menos 6 caracteres." });
    }

    const createdAt = new Date().toISOString();
    const result = await run("INSERT INTO feedbacks (user_id, message, created_at) VALUES (?, ?, ?)", [
      req.user.id,
      message,
      createdAt,
    ]);
    const user = await get("SELECT name, email, phone FROM users WHERE id = ?", [req.user.id]);

    return res.status(201).json({
      message: "Feedback enviado com sucesso. Obrigado por contribuir com a academia!",
      feedback: {
        id: result.lastID,
        user_name: user?.name || req.user?.name || "Aluno",
        email: user?.email || req.user?.email || "",
        phone: user?.phone || req.user?.phone || "",
        created_at: createdAt,
        message,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: "Erro ao enviar feedback", error: error.message });
  }
});

app.patch("/api/payments/:id/status", authRequired, adminRequired, async (req, res) => {
  const { status } = req.body;
  if (!["paid", "rejected", "pending"].includes(status)) {
    return res.status(400).json({ message: "Status invalido" });
  }

  const paidAt = status === "paid" ? new Date().toISOString() : null;
  await run("UPDATE payments SET status = ?, paid_at = ? WHERE id = ?", [status, paidAt, req.params.id]);
  return res.json({ message: "Status atualizado" });
});

app.patch("/api/payments/:id/admin-proof", authRequired, adminRequired, upload.single("proof"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "Envie um comprovante" });
  const proofFile = `/uploads/${req.file.filename}`;
  await run("UPDATE payments SET admin_proof_file = ? WHERE id = ?", [proofFile, req.params.id]);
  return res.json({ message: "Comprovante do administrativo anexado" });
});

app.patch("/api/admin/users/:id/password", authRequired, adminRequired, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ message: "A nova senha deve ter ao menos 6 caracteres" });
  }

  const target = await get("SELECT id, role FROM users WHERE id = ?", [req.params.id]);
  if (!target) return res.status(404).json({ message: "Usuario nao encontrado" });
  if (target.role === "admin") return res.status(403).json({ message: "Nao e permitido alterar senha de admin aqui" });

  const hash = await bcrypt.hash(String(newPassword), 10);
  await run("UPDATE users SET password_hash = ? WHERE id = ?", [hash, req.params.id]);
  return res.json({ message: "Senha redefinida com sucesso" });
});

app.delete("/api/admin/users/:id", authRequired, adminRequired, async (req, res) => {
  const target = await get("SELECT id, role FROM users WHERE id = ?", [req.params.id]);
  if (!target) return res.status(404).json({ message: "Usuario nao encontrado" });
  if (target.role === "admin") return res.status(403).json({ message: "Nao e permitido excluir administrador" });

  await run("DELETE FROM feedbacks WHERE user_id = ?", [req.params.id]);
  await run("DELETE FROM payments WHERE user_id = ?", [req.params.id]);
  await run("DELETE FROM users WHERE id = ?", [req.params.id]);
  return res.json({ message: "Cadastro excluido com sucesso" });
});

function getDashboardPeriodBounds(period) {
  const now = dayjs();
  if (/^\d{4}-\d{2}$/.test(period)) {
    const start = dayjs(`${period}-01`).startOf("day");
    const end = start.endOf("month");
    return {
      fromDate: start.toISOString(),
      toDate: end.toISOString(),
      kind: "calendar-month",
      monthRefForStatus: period,
    };
  }
  if (period === "year") {
    return {
      fromDate: now.subtract(1, "year").startOf("day").toISOString(),
      toDate: now.endOf("day").toISOString(),
      kind: "year",
      monthRefForStatus: monthRefNow(),
    };
  }
  if (period === "6months") {
    return {
      fromDate: now.subtract(6, "month").startOf("day").toISOString(),
      toDate: now.endOf("day").toISOString(),
      kind: "6months",
      monthRefForStatus: monthRefNow(),
    };
  }
  return {
    fromDate: now.subtract(1, "month").startOf("day").toISOString(),
    toDate: now.endOf("day").toISOString(),
    kind: "month",
    monthRefForStatus: monthRefNow(),
  };
}

app.get("/api/admin/dashboard", authRequired, adminRequired, async (_req, res) => {
  const period = _req.query.period || "month";
  const { fromDate, toDate, kind, monthRefForStatus } = getDashboardPeriodBounds(period);
  const month = monthRefForStatus;

  const monthly = await get(
    "SELECT COUNT(*) as paidCount, COALESCE(SUM(amount), 0) as total FROM payments WHERE status = 'paid' AND datetime(created_at) >= datetime(?) AND datetime(created_at) <= datetime(?)",
    [fromDate, toDate]
  );
  const perDay = await all(
    "SELECT substr(created_at, 1, 10) as day, COUNT(*) as qty, COALESCE(SUM(amount), 0) as total FROM payments WHERE status = 'paid' AND datetime(created_at) >= datetime(?) AND datetime(created_at) <= datetime(?) GROUP BY day ORDER BY day ASC LIMIT 400",
    [fromDate, toDate]
  );
  const users = await all("SELECT id, name, email, phone, role, created_at FROM users ORDER BY created_at DESC");
  const usersMonthlyRows = await all(
    `
    SELECT
      u.id,
      u.name,
      u.email,
      u.phone,
      u.created_at,
      (
        SELECT p1.status FROM payments p1
        WHERE p1.user_id = u.id
        ORDER BY datetime(p1.created_at) DESC
        LIMIT 1
      ) AS latest_payment_status,
      (
        SELECT p1.created_at FROM payments p1
        WHERE p1.user_id = u.id
        ORDER BY datetime(p1.created_at) DESC
        LIMIT 1
      ) AS latest_payment_at,
      (
        SELECT p1.month_ref FROM payments p1
        WHERE p1.user_id = u.id
        ORDER BY datetime(p1.created_at) DESC
        LIMIT 1
      ) AS latest_payment_month_ref,
      (
        SELECT p2.created_at FROM payments p2
        WHERE p2.user_id = u.id AND p2.status = 'paid'
        ORDER BY datetime(p2.created_at) DESC
        LIMIT 1
      ) AS last_paid_at
    FROM users u
    WHERE u.role = 'user'
    ORDER BY u.created_at DESC
    `
  );
  const usersMonthly = usersMonthlyRows.map((userRow) => {
    const paymentAvailability = getPaymentAvailability({
      latestPayment: userRow.latest_payment_status
        ? {
            status: userRow.latest_payment_status,
            month_ref: userRow.latest_payment_month_ref,
            created_at: userRow.latest_payment_at,
          }
        : null,
      latestPaidPayment: userRow.last_paid_at
        ? {
            status: "paid",
            created_at: userRow.last_paid_at,
          }
        : null,
    });
    const planSummary = getPlanStatusSummary({
      lastPaidAt: userRow.last_paid_at,
    });

    return {
      ...userRow,
      last_payment_at: userRow.latest_payment_at,
      last_paid_at: userRow.last_paid_at,
      payment_state: paymentAvailability.status,
      can_submit_payment: paymentAvailability.canSubmit,
      next_unlock_at: paymentAvailability.nextUnlockAt,
      next_due_at: planSummary.nextDueAt || paymentAvailability.nextDueAt,
      reference_month: paymentAvailability.referenceMonth,
      days_overdue: planSummary.daysOverdue,
      current_cycle_paid: planSummary.currentCyclePaid,
      plan_status: planSummary.planStatus,
    };
  });
  const forms = await all(
    "SELECT p.id, u.name AS user_name, p.amount, p.month_ref, p.status, p.proof_file, p.admin_proof_file, p.payment_method, p.created_at, p.paid_at, p.confirmed_at, u.email, u.phone FROM payments p JOIN users u ON u.id = p.user_id WHERE datetime(p.created_at) >= datetime(?) AND datetime(p.created_at) <= datetime(?) ORDER BY datetime(p.created_at) DESC",
    [fromDate, toDate]
  );
  const feedbacks = await all(
    "SELECT f.id, f.message, f.created_at, u.name AS user_name, u.email, u.phone FROM feedbacks f JOIN users u ON u.id = f.user_id ORDER BY datetime(f.created_at) DESC LIMIT 200"
  );

  const monthsWithDataRows = await all("SELECT DISTINCT month_ref AS ym FROM payments ORDER BY ym DESC");
  const monthsWithData = monthsWithDataRows.map((r) => r.ym);

  return res.json({
    month,
    period,
    periodKind: kind,
    paidCount: monthly?.paidCount || 0,
    monthlyRevenue: monthly?.total || 0,
    perDay,
    users,
    usersMonthly,
    forms,
    feedbacks,
    monthsWithData,
  });
});

async function bootstrap() {
  await initDb();
  await ensureAdmin();
  await run("UPDATE payments SET status = 'pending' WHERE status = 'draft'");
  const startupCleanup = await cleanupExpiredProofs();
  if (startupCleanup.affectedPayments || startupCleanup.removedFiles) {
    console.log(
      `Limpeza automática concluída: ${startupCleanup.affectedPayments} pagamento(s) revisado(s), ${startupCleanup.removedFiles} arquivo(s) removido(s).`
    );
  }

  const cleanupTimer = setInterval(async () => {
    try {
      const cleanupResult = await cleanupExpiredProofs();
      if (cleanupResult.affectedPayments || cleanupResult.removedFiles) {
        console.log(
          `Limpeza automática concluída: ${cleanupResult.affectedPayments} pagamento(s) revisado(s), ${cleanupResult.removedFiles} arquivo(s) removido(s).`
        );
      }
    } catch (error) {
      console.error("Erro ao limpar comprovantes antigos:", error);
    }
  }, proofCleanupIntervalMs);
  cleanupTimer.unref?.();

  if (fs.existsSync(clientDistDir)) {
    app.use(express.static(clientDistDir));
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api") || req.path.startsWith("/uploads")) return next();
      res.sendFile(path.join(clientDistDir, "index.html"), (err) => (err ? next(err) : undefined));
    });
  }

  const host = process.env.HOST || "0.0.0.0";
  app.listen(PORT, host, () => {
    console.log(`Servidor (site + API) em http://${host === "0.0.0.0" ? "localhost" : host}:${PORT}`);
  });
}

bootstrap();

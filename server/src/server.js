import express from "express";
import cors from "cors";
import multer from "multer";
import bcrypt from "bcryptjs";
import path from "path";
import fs from "fs";
import process from "node:process";
import { fileURLToPath } from "url";
import dayjs from "dayjs";
import { all, get, initDb, run } from "./db.js";
import { USING_DEFAULT_JWT_SECRET, adminRequired, authRequired, signToken } from "./auth.js";

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
const authRateLimitWindowMs = Math.max(60_000, Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS) || 10 * 60 * 1000);
const authRateLimitMaxAttempts = Math.max(3, Number(process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS) || 8);
const proofUploadMaxBytes = Math.max(512_000, Number(process.env.PROOF_UPLOAD_MAX_BYTES) || 5 * 1024 * 1024);
const proofUploadMaxMbLabel = Number((proofUploadMaxBytes / (1024 * 1024)).toFixed(1));
const authAttemptStore = new Map();
const allowedProofMimeTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"]);
const allowedProofExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".pdf"]);
const phoneDigitsLength = 11;
const defaultBootstrapAdminName = String(process.env.DEFAULT_ADMIN_NAME || "Administrador").trim() || "Administrador";
const defaultBootstrapAdminEmail = normalizeEmail(process.env.DEFAULT_ADMIN_EMAIL || "admin@esportesce.com");
const defaultBootstrapAdminPhone = normalizePhone(process.env.DEFAULT_ADMIN_PHONE || "");
const defaultBootstrapAdminPassword = String(process.env.DEFAULT_ADMIN_PASSWORD || "admin123");
const usingDefaultBootstrapAdminCredentials = !process.env.DEFAULT_ADMIN_EMAIL || !process.env.DEFAULT_ADMIN_PASSWORD;

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function getPhoneDigits(value) {
  return String(value || "").replace(/\D/g, "").slice(0, phoneDigitsLength);
}

function normalizePhone(value) {
  const digits = getPhoneDigits(value);
  if (!digits || digits.length !== phoneDigitsLength) return null;
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 3)} ${digits.slice(3, 7)}-${digits.slice(7, 11)}`;
}

function validatePasswordStrength(password) {
  const value = String(password || "");
  if (value.length < 8) return "A senha precisa ter pelo menos 8 caracteres.";
  if (!/[A-Za-zÀ-ÿ]/.test(value) || !/\d/.test(value)) {
    return "A senha precisa conter pelo menos 1 letra e 1 número.";
  }
  return "";
}

function getClientIdentifier(req) {
  const forwardedFor = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return String(req.headers["cf-connecting-ip"] || forwardedFor || req.ip || req.socket?.remoteAddress || "unknown").trim();
}

function getAuthRateLimitKey(req, email) {
  return `${getClientIdentifier(req)}:${normalizeEmail(email) || "sem-email"}`;
}

function getAuthRateLimitEntry(key, now = Date.now()) {
  const entry = authAttemptStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    authAttemptStore.delete(key);
    return null;
  }
  return entry;
}

function recordFailedAuthAttempt(key, now = Date.now()) {
  const current = getAuthRateLimitEntry(key, now);
  if (!current) {
    authAttemptStore.set(key, { count: 1, expiresAt: now + authRateLimitWindowMs });
    return;
  }
  current.count += 1;
  authAttemptStore.set(key, current);
}

function clearFailedAuthAttempts(key) {
  authAttemptStore.delete(key);
}

function buildAuthRateLimitMessage(entry, now = Date.now()) {
  const retryInSeconds = Math.max(1, Math.ceil((entry.expiresAt - now) / 1000));
  return `Muitas tentativas de login. Aguarde ${retryInSeconds}s e tente novamente.`;
}

function proofUploadFileFilter(_req, file, cb) {
  const extension = path.extname(file.originalname || "").toLowerCase();
  const isMimeAllowed = allowedProofMimeTypes.has(file.mimetype);
  const isExtensionAllowed = allowedProofExtensions.has(extension);
  if (isMimeAllowed && isExtensionAllowed) return cb(null, true);
  const error = new Error("Formato de arquivo inválido. Envie PNG, JPG, WEBP, GIF ou PDF.");
  error.statusCode = 400;
  return cb(error);
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: proofUploadMaxBytes, files: 10 },
  fileFilter: proofUploadFileFilter,
});

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (req.secure || req.headers["x-forwarded-proto"] === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  next();
});
app.use(cors());
app.use(express.json({ limit: "200kb" }));
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

async function deleteUploadList(fileUrls = []) {
  let removedFiles = 0;
  for (const fileUrl of fileUrls) {
    if (await deleteUploadByUrl(fileUrl)) removedFiles += 1;
  }
  return removedFiles;
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

function parseCurrencyAmount(value) {
  const rawValue = String(value ?? "").trim();
  if (!rawValue) return Number.NaN;
  const normalizedValue = rawValue.includes(",") ? rawValue.replace(/\./g, "").replace(",", ".") : rawValue;
  const amount = Number(normalizedValue);
  if (!Number.isFinite(amount)) return Number.NaN;
  return Number(amount.toFixed(2));
}

function getFinanceTimelineConfig(kind) {
  if (kind === "6months" || kind === "year") {
    return {
      bucketType: "month",
      paymentBucketExpression: "substr(created_at, 1, 7)",
      expenseBucketExpression: "substr(expense_date, 1, 7)",
    };
  }

  return {
    bucketType: "day",
    paymentBucketExpression: "substr(created_at, 1, 10)",
    expenseBucketExpression: "substr(expense_date, 1, 10)",
  };
}

function formatFinanceBucketLabel(bucket, bucketType) {
  if (!bucket) return "—";
  if (bucketType === "month") {
    const [year, month] = String(bucket).split("-").map(Number);
    return new Date(year, (month || 1) - 1, 1).toLocaleDateString("pt-BR", { month: "2-digit", year: "2-digit" });
  }
  return new Date(`${bucket}T12:00:00`).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
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
  if (admin) return { created: false, usedDefaultCredentials: false };

  const passwordError = validatePasswordStrength(defaultBootstrapAdminPassword);
  if (passwordError) {
    throw new Error(`DEFAULT_ADMIN_PASSWORD inválida. ${passwordError}`);
  }

  const hash = await bcrypt.hash(defaultBootstrapAdminPassword, 10);
  const createdAt = new Date().toISOString();
  await run(
    "INSERT INTO users (name, email, phone, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'admin', ?)",
    [defaultBootstrapAdminName, defaultBootstrapAdminEmail, defaultBootstrapAdminPhone, hash, createdAt]
  );

  return { created: true, usedDefaultCredentials: usingDefaultBootstrapAdminCredentials };
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/auth/register", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const email = normalizeEmail(req.body?.email);
    const rawPhone = req.body?.phone;
    const phone = normalizePhone(req.body?.phone);
    const password = String(req.body?.password || "");
    if (!name || !email || !password) {
      return res.status(400).json({ message: "Preencha nome, e-mail, telefone e senha." });
    }
    if (!phone || getPhoneDigits(rawPhone).length !== phoneDigitsLength) {
      return res.status(400).json({ message: "Informe o telefone no formato (85) 9 9850-6905." });
    }
    const passwordError = validatePasswordStrength(password);
    if (passwordError) {
      return res.status(400).json({ message: passwordError });
    }

    const exists = await get("SELECT id FROM users WHERE LOWER(email) = ?", [email]);
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
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");
    if (!email || !password) {
      return res.status(400).json({ message: "Informe e-mail e senha." });
    }

    const rateLimitKey = getAuthRateLimitKey(req, email);
    const limitedEntry = getAuthRateLimitEntry(rateLimitKey);
    if (limitedEntry && limitedEntry.count >= authRateLimitMaxAttempts) {
      return res.status(429).json({ message: buildAuthRateLimitMessage(limitedEntry) });
    }

    const user = await get("SELECT * FROM users WHERE LOWER(email) = ?", [email]);
    if (!user) {
      recordFailedAuthAttempt(rateLimitKey);
      return res.status(401).json({ message: "Credenciais inválidas." });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      recordFailedAuthAttempt(rateLimitKey);
      return res.status(401).json({ message: "Credenciais inválidas." });
    }

    clearFailedAuthAttempts(rateLimitKey);
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

app.patch("/api/auth/password", authRequired, async (req, res) => {
  const currentPassword = String(req.body?.currentPassword || "");
  const newPassword = String(req.body?.newPassword || "");
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ message: "Informe a senha atual e a nova senha." });
  }
  if (currentPassword === newPassword) {
    return res.status(400).json({ message: "A nova senha deve ser diferente da senha atual." });
  }

  const passwordError = validatePasswordStrength(newPassword);
  if (passwordError) {
    return res.status(400).json({ message: passwordError });
  }

  const user = await get("SELECT id, password_hash FROM users WHERE id = ?", [req.user.id]);
  if (!user) return res.status(404).json({ message: "Usuário não encontrado." });

  const valid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!valid) {
    return res.status(401).json({ message: "A senha atual está incorreta." });
  }

  const hash = await bcrypt.hash(newPassword, 10);
  await run("UPDATE users SET password_hash = ? WHERE id = ?", [hash, req.user.id]);
  return res.json({ message: "Senha atualizada com sucesso." });
});

app.post("/api/admin/users", authRequired, adminRequired, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const email = normalizeEmail(req.body?.email);
    const rawPhone = req.body?.phone;
    const phone = normalizePhone(req.body?.phone);
    const password = String(req.body?.password || "");
    if (!name || !email || !password) {
      return res.status(400).json({ message: "Preencha nome, e-mail e senha do novo administrador." });
    }
    if (String(rawPhone || "").trim() && (!phone || getPhoneDigits(rawPhone).length !== phoneDigitsLength)) {
      return res.status(400).json({ message: "Informe o telefone no formato (85) 9 9850-6905." });
    }

    const passwordError = validatePasswordStrength(password);
    if (passwordError) {
      return res.status(400).json({ message: passwordError });
    }

    const exists = await get("SELECT id FROM users WHERE LOWER(email) = ?", [email]);
    if (exists) return res.status(409).json({ message: "E-mail já cadastrado." });

    const createdAt = new Date().toISOString();
    const hash = await bcrypt.hash(password, 10);
    const result = await run(
      "INSERT INTO users (name, email, phone, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'admin', ?)",
      [name, email, phone, hash, createdAt]
    );

    return res.status(201).json({
      message: "Administrador criado com sucesso.",
      user: { id: result.lastID, name, email, phone, role: "admin", created_at: createdAt },
    });
  } catch (error) {
    return res.status(500).json({ message: "Erro ao criar administrador", error: error.message });
  }
});

app.post("/api/admin/expenses", authRequired, adminRequired, upload.array("receipts", 10), async (req, res) => {
  const uploadedFiles = Array.isArray(req.files) ? req.files : [];
  const uploadedFileUrls = uploadedFiles.map((file) => `/uploads/${file.filename}`);
  let createdExpenseId = null;

  try {
    const title = String(req.body?.title || "").trim();
    const description = String(req.body?.description || "").trim();
    const amount = parseCurrencyAmount(req.body?.amount);
    const expenseDateInput = String(req.body?.expenseDate || "").trim();
    const expenseDateValue = expenseDateInput ? dayjs(expenseDateInput) : dayjs();

    if (!title) {
      await deleteUploadList(uploadedFileUrls);
      return res.status(400).json({ message: "Informe o título do gasto." });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      await deleteUploadList(uploadedFileUrls);
      return res.status(400).json({ message: "Informe um valor válido para o gasto." });
    }
    if (!expenseDateValue.isValid()) {
      await deleteUploadList(uploadedFileUrls);
      return res.status(400).json({ message: "Informe uma data válida para o gasto." });
    }
    if (description.length > 1500) {
      await deleteUploadList(uploadedFileUrls);
      return res.status(400).json({ message: "A descrição pode ter no máximo 1500 caracteres." });
    }

    const expenseDate = expenseDateValue.startOf("day").toISOString();
    const monthRef = monthRefFromDate(expenseDate);
    const createdAt = new Date().toISOString();

    const result = await run(
      "INSERT INTO expenses (title, description, amount, expense_date, month_ref, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [title, description || null, amount, expenseDate, monthRef, req.user.id, createdAt]
    );

    createdExpenseId = result.lastID;

    for (const file of uploadedFiles) {
      await run(
        "INSERT INTO expense_attachments (expense_id, file_url, original_name, created_at) VALUES (?, ?, ?, ?)",
        [createdExpenseId, `/uploads/${file.filename}`, file.originalname || file.filename, createdAt]
      );
    }

    return res.status(201).json({
      message: "Gasto registrado com sucesso.",
      expense: {
        id: createdExpenseId,
        title,
        description: description || null,
        amount,
        expense_date: expenseDate,
        month_ref: monthRef,
        created_at: createdAt,
        created_by_user_id: req.user.id,
        created_by_name: req.user.name,
        attachments: uploadedFiles.map((file) => ({
          file_url: `/uploads/${file.filename}`,
          original_name: file.originalname || file.filename,
          created_at: createdAt,
        })),
      },
    });
  } catch (error) {
    if (createdExpenseId) {
      await run("DELETE FROM expense_attachments WHERE expense_id = ?", [createdExpenseId]);
      await run("DELETE FROM expenses WHERE id = ?", [createdExpenseId]);
    }
    await deleteUploadList(uploadedFileUrls);
    return res.status(500).json({ message: "Erro ao registrar gasto", error: error.message });
  }
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
  const passwordError = validatePasswordStrength(newPassword);
  if (passwordError) {
    return res.status(400).json({ message: passwordError });
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
  const financeTimelineConfig = getFinanceTimelineConfig(kind);

  const monthly = await get(
    "SELECT COUNT(*) as paidCount, COALESCE(SUM(amount), 0) as total FROM payments WHERE status = 'paid' AND datetime(created_at) >= datetime(?) AND datetime(created_at) <= datetime(?)",
    [fromDate, toDate]
  );
  const perDay = await all(
    "SELECT substr(created_at, 1, 10) as day, COUNT(*) as qty, COALESCE(SUM(amount), 0) as total FROM payments WHERE status = 'paid' AND datetime(created_at) >= datetime(?) AND datetime(created_at) <= datetime(?) GROUP BY day ORDER BY day ASC LIMIT 400",
    [fromDate, toDate]
  );
  const financeRevenueSeries = await all(
    `SELECT ${financeTimelineConfig.paymentBucketExpression} as bucket, COALESCE(SUM(amount), 0) as total FROM payments WHERE status = 'paid' AND datetime(created_at) >= datetime(?) AND datetime(created_at) <= datetime(?) GROUP BY bucket ORDER BY bucket ASC LIMIT 400`,
    [fromDate, toDate]
  );
  const financeExpenseSummary = await get(
    "SELECT COUNT(*) as expenseCount, COALESCE(SUM(amount), 0) as total FROM expenses WHERE datetime(expense_date) >= datetime(?) AND datetime(expense_date) <= datetime(?)",
    [fromDate, toDate]
  );
  const financeExpenseSeries = await all(
    `SELECT ${financeTimelineConfig.expenseBucketExpression} as bucket, COALESCE(SUM(amount), 0) as total FROM expenses WHERE datetime(expense_date) >= datetime(?) AND datetime(expense_date) <= datetime(?) GROUP BY bucket ORDER BY bucket ASC LIMIT 400`,
    [fromDate, toDate]
  );
  const financeTotals = await get(
    "SELECT (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'paid') as totalRevenueAllTime, (SELECT COALESCE(SUM(amount), 0) FROM expenses) as totalExpensesAllTime"
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
  const expenses = await all(
    "SELECT e.id, e.title, e.description, e.amount, e.expense_date, e.month_ref, e.created_at, e.created_by_user_id, u.name AS created_by_name FROM expenses e LEFT JOIN users u ON u.id = e.created_by_user_id WHERE datetime(e.expense_date) >= datetime(?) AND datetime(e.expense_date) <= datetime(?) ORDER BY datetime(e.expense_date) DESC, datetime(e.created_at) DESC",
    [fromDate, toDate]
  );
  const expenseAttachments = await all(
    "SELECT ea.id, ea.expense_id, ea.file_url, ea.original_name, ea.created_at FROM expense_attachments ea JOIN expenses e ON e.id = ea.expense_id WHERE datetime(e.expense_date) >= datetime(?) AND datetime(e.expense_date) <= datetime(?) ORDER BY datetime(ea.created_at) ASC, ea.id ASC",
    [fromDate, toDate]
  );
  const expenseAttachmentsById = expenseAttachments.reduce((accumulator, attachment) => {
    if (!accumulator[attachment.expense_id]) accumulator[attachment.expense_id] = [];
    accumulator[attachment.expense_id].push({
      id: attachment.id,
      file_url: attachment.file_url,
      original_name: attachment.original_name,
      created_at: attachment.created_at,
    });
    return accumulator;
  }, {});
  const normalizedExpenses = expenses.map((expense) => {
    const attachments = expenseAttachmentsById[expense.id] || [];
    return {
      ...expense,
      attachments,
      attachment_count: attachments.length,
    };
  });
  const financeBuckets = new Map();
  for (const item of financeRevenueSeries) {
    financeBuckets.set(item.bucket, {
      bucket: item.bucket,
      label: formatFinanceBucketLabel(item.bucket, financeTimelineConfig.bucketType),
      revenue: Number(item.total || 0),
      expenses: 0,
    });
  }
  for (const item of financeExpenseSeries) {
    const currentEntry = financeBuckets.get(item.bucket) || {
      bucket: item.bucket,
      label: formatFinanceBucketLabel(item.bucket, financeTimelineConfig.bucketType),
      revenue: 0,
      expenses: 0,
    };
    currentEntry.expenses = Number(item.total || 0);
    financeBuckets.set(item.bucket, currentEntry);
  }
  const financeTimeline = Array.from(financeBuckets.values())
    .sort((left, right) => String(left.bucket).localeCompare(String(right.bucket)))
    .map((item) => ({
      ...item,
      balance: Number((item.revenue - item.expenses).toFixed(2)),
    }));
  const periodRevenue = Number(monthly?.total || 0);
  const periodExpenses = Number(financeExpenseSummary?.total || 0);
  const totalRevenueAllTime = Number(financeTotals?.totalRevenueAllTime || 0);
  const totalExpensesAllTime = Number(financeTotals?.totalExpensesAllTime || 0);
  const monthsWithDataRows = await all(
    "SELECT DISTINCT ym FROM (SELECT month_ref AS ym FROM payments UNION SELECT month_ref AS ym FROM expenses) WHERE ym IS NOT NULL ORDER BY ym DESC"
  );
  const monthsWithData = monthsWithDataRows.map((r) => r.ym);

  return res.json({
    month,
    period,
    periodKind: kind,
    paidCount: monthly?.paidCount || 0,
    monthlyRevenue: periodRevenue,
    perDay,
    users,
    usersMonthly,
    forms,
    feedbacks,
    finance: {
      periodRevenue,
      periodExpenses,
      periodBalance: Number((periodRevenue - periodExpenses).toFixed(2)),
      totalRevenueAllTime,
      totalExpensesAllTime,
      totalBalance: Number((totalRevenueAllTime - totalExpensesAllTime).toFixed(2)),
      expenseCount: Number(financeExpenseSummary?.expenseCount || 0),
      timelineBucketType: financeTimelineConfig.bucketType,
      timeline: financeTimeline,
      expenses: normalizedExpenses,
    },
    monthsWithData,
  });
});

async function bootstrap() {
  await initDb();
  const adminBootstrap = await ensureAdmin();
  await run("UPDATE payments SET status = 'pending' WHERE status = 'draft'");
  if (USING_DEFAULT_JWT_SECRET) {
    console.warn("AVISO DE SEGURANÇA: defina JWT_SECRET em produção para não usar o segredo padrão do projeto.");
  }
  if (adminBootstrap.created && adminBootstrap.usedDefaultCredentials) {
    console.warn(
      "AVISO DE SEGURANÇA: o administrador inicial foi criado com credenciais padrão. Troque a senha e crie um novo admin assim que possível."
    );
  }
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

  app.use((error, _req, res, next) => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ message: `O arquivo deve ter no máximo ${proofUploadMaxMbLabel} MB.` });
      }
      return res.status(400).json({ message: "Não foi possível processar o arquivo enviado." });
    }
    if (error?.statusCode && error?.message) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    console.error("Erro não tratado:", error);
    return res.status(500).json({ message: "Erro interno do servidor." });
  });

  const host = process.env.HOST || "0.0.0.0";
  app.listen(PORT, host, () => {
    console.log(`Servidor (site + API) em http://${host === "0.0.0.0" ? "localhost" : host}:${PORT}`);
  });
}

bootstrap();

import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { AnimatePresence, motion } from "framer-motion";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

/** Em dev o Vite encaminha /api para o backend. Em produção o Express serve site + API na mesma origem. */
const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || "/api",
});

function HoverMenu({ label, align = "end", triggerClassName = "", children }) {
  const alignClass = align === "start" ? "hover-menu--start" : "hover-menu--end";
  return (
    <div className={`hover-menu ${alignClass}`}>
      <button type="button" className={`hover-menu-trigger ${triggerClassName}`.trim()}>
        {label}
      </button>
      <div className="hover-menu-panel" role="menu">
        {children}
      </div>
    </div>
  );
}

function monthTitlePt(ym) {
  if (!ym || !/^\d{4}-\d{2}$/.test(String(ym))) return "Sem referência";
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
}

function formatDatePt(value) {
  if (!value) return "Sem data";
  return new Date(value).toLocaleDateString("pt-BR");
}

function formatDateTimePt(value) {
  if (!value) return "Sem data";
  return new Date(value).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addMonthsKeepingDay(value, months) {
  const base = new Date(value);
  const originalDay = base.getDate();
  const next = new Date(base);
  next.setDate(1);
  next.setMonth(next.getMonth() + months);
  const lastDayOfTargetMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(originalDay, lastDayOfTargetMonth));
  next.setHours(0, 0, 0, 0);
  return next;
}

function monthRefFromDate(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function getNextPaymentWindow(lastPaidAt) {
  if (!lastPaidAt) return null;

  const nextDueAt = addMonthsKeepingDay(lastPaidAt, 1);
  const nextUnlockAt = new Date(nextDueAt);
  nextUnlockAt.setDate(nextUnlockAt.getDate() - 3);
  nextUnlockAt.setHours(0, 0, 0, 0);

  return {
    referenceMonth: monthRefFromDate(nextDueAt),
    nextUnlockAt: nextUnlockAt.toISOString(),
    nextDueAt: nextDueAt.toISOString(),
  };
}

function derivePaymentAvailabilityFromPayments(payments) {
  const ordered = [...(payments || [])].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const latestPayment = ordered[0] || null;
  const latestPaidPayment = ordered.find((payment) => payment.status === "paid") || null;
  const nextWindow = latestPaidPayment ? getNextPaymentWindow(latestPaidPayment.created_at) : null;
  const referenceFromWindow = nextWindow?.referenceMonth || monthRefFromDate(new Date());

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
      nextUnlockAt: nextWindow?.nextUnlockAt || null,
      nextDueAt: nextWindow?.nextDueAt || null,
      lastPaidAt: latestPaidPayment?.created_at || null,
    };
  }

  if (latestPayment.status === "rejected") {
    return {
      status: "retry_payment",
      canSubmit: true,
      referenceMonth: latestPayment.month_ref || referenceFromWindow,
      nextUnlockAt: nextWindow?.nextUnlockAt || null,
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

  if (startOfDay(new Date()) < startOfDay(nextWindow.nextUnlockAt)) {
    return {
      status: "up_to_date",
      canSubmit: false,
      referenceMonth: nextWindow.referenceMonth,
      nextUnlockAt: nextWindow.nextUnlockAt,
      nextDueAt: nextWindow.nextDueAt,
      lastPaidAt: latestPaidPayment?.created_at || null,
    };
  }

  return {
    status: "payment_available",
    canSubmit: true,
    referenceMonth: nextWindow.referenceMonth,
    nextUnlockAt: nextWindow.nextUnlockAt,
    nextDueAt: nextWindow.nextDueAt,
    lastPaidAt: latestPaidPayment?.created_at || null,
  };
}

function planStatusLabel(status) {
  switch (status) {
    case "pending":
      return "Pagamento pendente";
    case "active":
      return "Ativo";
    case "late":
      return "Atrasado";
    case "inactive":
      return "Inativo";
    default:
      return "Sem status";
  }
}

function planStatusTone(status) {
  switch (status) {
    case "active":
      return "paid";
    case "pending":
      return "pending";
    case "inactive":
      return "rejected";
    case "late":
    default:
      return "pending";
  }
}

function normalizeDashboardUser(userRow) {
  const lastPaidAt = userRow.last_paid_at || (userRow.paid_this_month ? userRow.last_payment_at : null);
  const dueAt = userRow.next_due_at || (lastPaidAt ? addMonthsKeepingDay(lastPaidAt, 1).toISOString() : null);
  const overdueDays = dueAt ? Math.max(0, Math.floor((startOfDay(new Date()) - startOfDay(dueAt)) / 86400000)) : 0;
  const latestStatus = userRow.latest_payment_status || userRow.payment_state || null;
  const planStatus = userRow.plan_status || (!lastPaidAt ? "pending" : overdueDays > 10 ? "inactive" : overdueDays > 0 ? "late" : "active");
  const currentCyclePaid = userRow.current_cycle_paid ?? Boolean(lastPaidAt && overdueDays === 0);

  return {
    ...userRow,
    last_paid_at: lastPaidAt,
    next_due_at: dueAt,
    days_overdue: userRow.days_overdue ?? overdueDays,
    plan_status: planStatus,
    payment_state:
      userRow.payment_state ||
      (latestStatus === "pending"
        ? "pending_review"
        : latestStatus === "rejected"
          ? "retry_payment"
          : userRow.paid_this_month || latestStatus === "paid"
            ? "up_to_date"
            : "first_payment"),
    current_cycle_paid: currentCyclePaid,
  };
}

function describeUserPayment(userRow) {
  const details = [];

  if (userRow.plan_status === "pending") details.push("pagamento pendente");
  else if (userRow.current_cycle_paid) details.push("mensalidade em dia");
  else if (userRow.days_overdue > 0) details.push(`${userRow.days_overdue} dia(s) de atraso`);
  else details.push("sem pagamento confirmado");

  if (userRow.next_due_at) details.push(`vencimento em ${formatDatePt(userRow.next_due_at)}`);

  if (userRow.last_paid_at) details.push(`último pagamento em ${formatDatePt(userRow.last_paid_at)}`);
  else details.push(`cadastro em ${formatDatePt(userRow.created_at)}`);

  if (userRow.payment_state === "pending_review") details.push("novo envio em análise");
  if (userRow.payment_state === "retry_payment") details.push("último envio recusado");

  return details.join(" — ");
}

function App() {
  const [token, setToken] = useState(localStorage.getItem("token") || "");
  const [user, setUser] = useState(JSON.parse(localStorage.getItem("user") || "null"));
  const [authType, setAuthType] = useState("login");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [payments, setPayments] = useState([]);
  const [paymentsLoaded, setPaymentsLoaded] = useState(false);
  const [paymentAvailability, setPaymentAvailability] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [previewImage, setPreviewImage] = useState("");
  const [selectedPaymentId, setSelectedPaymentId] = useState(null);
  const [adminProofFile, setAdminProofFile] = useState(null);
  const [paymentFilter, setPaymentFilter] = useState("all");
  const [userStatusFilter, setUserStatusFilter] = useState("all");
  const [dashboardPeriod, setDashboardPeriod] = useState("month");
  const [showAllForms, setShowAllForms] = useState(false);
  const [showAllUsers, setShowAllUsers] = useState(false);

  const [authForm, setAuthForm] = useState({ name: "", email: "", phone: "", password: "" });
  const [payForm, setPayForm] = useState({ proof: null, paymentMethod: "pix" });
  const [feedbackForm, setFeedbackForm] = useState("");
  const [feedbackSending, setFeedbackSending] = useState(false);
  const [showAllFeedbacks, setShowAllFeedbacks] = useState(false);
  const [paymentCelebration, setPaymentCelebration] = useState(null);

  useEffect(() => {
    api.defaults.headers.common.Authorization = token ? `Bearer ${token}` : "";
    if (!token) return;
    if (user?.role === "admin") loadDashboard(dashboardPeriod);
    else loadMyPayments();
  }, [token, user?.role, dashboardPeriod]);

  useEffect(() => {
    if (!token) return;

    let ignore = false;

    async function syncCurrentUser() {
      try {
        const { data } = await api.get("/me");
        if (ignore || !data) return;
        setUser((prev) => {
          const nextUser = { ...(prev || {}), ...data };
          localStorage.setItem("user", JSON.stringify(nextUser));
          return nextUser;
        });
      } catch {
        if (ignore) return;
      }
    }

    syncCurrentUser();

    return () => {
      ignore = true;
    };
  }, [token]);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(""), 3500);
    return () => clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    if (!paymentCelebration) return;
    const timer = setTimeout(() => setPaymentCelebration(null), 2400);
    return () => clearTimeout(timer);
  }, [paymentCelebration]);

  const isAdmin = user?.role === "admin";
  const telaClass = !token ? "tela-login" : isAdmin ? "tela-admin" : "tela-usuario";
  const chartData = useMemo(
    () => (dashboard?.perDay || []).map((item) => ({ dia: item.day.slice(5), valor: Number(item.total) })),
    [dashboard]
  );
  const filteredForms = useMemo(() => {
    if (!dashboard?.forms) return [];
    if (paymentFilter === "all") return dashboard.forms;
    return dashboard.forms.filter((item) => item.status === paymentFilter);
  }, [dashboard, paymentFilter]);
  const normalizedUsers = useMemo(
    () => (dashboard?.usersMonthly || []).map((userRow) => normalizeDashboardUser(userRow)),
    [dashboard?.usersMonthly]
  );
  const filteredUsers = useMemo(() => {
    if (userStatusFilter === "all") return normalizedUsers;
    return normalizedUsers.filter((userRow) => userRow.plan_status === userStatusFilter);
  }, [normalizedUsers, userStatusFilter]);
  const visibleForms = useMemo(
    () => (showAllForms ? filteredForms : filteredForms.slice(0, 3)),
    [filteredForms, showAllForms]
  );
  const visibleUsers = useMemo(
    () => (showAllUsers ? filteredUsers : filteredUsers.slice(0, 3)),
    [filteredUsers, showAllUsers]
  );
  const visibleFeedbacks = useMemo(
    () => (showAllFeedbacks ? dashboard?.feedbacks || [] : (dashboard?.feedbacks || []).slice(0, 3)),
    [dashboard?.feedbacks, showAllFeedbacks]
  );

  const dashboardPeriodLabel = useMemo(() => {
    const p = dashboardPeriod;
    if (/^\d{4}-\d{2}$/.test(p)) {
      const t = monthTitlePt(p);
      return {
        revenueTitle: `Receita em ${t}`,
        payersTitle: "Pagamentos confirmados",
        chartSubtitle: `Total recebido por dia em ${t} (pagamentos confirmados).`,
      };
    }
    if (p === "year") {
      return {
        revenueTitle: "Receita no último ano",
        payersTitle: "Pagamentos confirmados",
        chartSubtitle: "Total recebido por dia no período (últimos 12 meses).",
      };
    }
    if (p === "6months") {
      return {
        revenueTitle: "Receita nos últimos 6 meses",
        payersTitle: "Pagamentos confirmados",
        chartSubtitle: "Total recebido por dia no período (últimos 6 meses).",
      };
    }
    return {
      revenueTitle: "Receita no último mês",
      payersTitle: "Pagamentos confirmados",
      chartSubtitle: "Total recebido por dia no período (aprox. últimos 30 dias).",
    };
  }, [dashboardPeriod]);

  const statusLabel = {
    draft: "Aguardando análise",
    pending: "Aguardando análise",
    paid: "Pago",
    rejected: "Rejeitado",
  };
  const money = (value) =>
    Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const resolvedPaymentAvailability = useMemo(() => {
    if (paymentAvailability) return paymentAvailability;
    if (!paymentsLoaded) return null;
    return derivePaymentAvailabilityFromPayments(payments);
  }, [paymentAvailability, paymentsLoaded, payments]);
  const currentPaymentStatus = resolvedPaymentAvailability?.status;
  const nextUnlockLabel = resolvedPaymentAvailability?.nextUnlockAt ? formatDatePt(resolvedPaymentAvailability.nextUnlockAt) : "";
  const nextDueLabel = resolvedPaymentAvailability?.nextDueAt ? formatDatePt(resolvedPaymentAvailability.nextDueAt) : "";

  const awaitingReview = currentPaymentStatus === "pending_review";
  const paymentDone = currentPaymentStatus === "up_to_date";
  const paymentAvailable = currentPaymentStatus === "payment_available";
  const retryPayment = currentPaymentStatus === "retry_payment";
  const paymentSectionReady = Boolean(resolvedPaymentAvailability) || paymentsLoaded;
  const canStartPayment = paymentSectionReady && (resolvedPaymentAvailability?.canSubmit ?? true);
  const trainingUntilLabel = nextDueLabel;
  const paymentSituationLabel = awaitingReview
    ? "Aguardando análise"
    : paymentDone
      ? "Mensalidade em dia"
      : paymentAvailable
        ? "Pagamento liberado"
        : retryPayment
          ? "Reenvio necessário"
          : "Primeiro pagamento";
  const paymentHero = useMemo(() => {
    if (!paymentSectionReady) {
      return {
        emoji: "⏳",
        title: "Carregando sua situação",
        description: "Estamos conferindo seu ciclo de pagamento e liberando as informações certas para você.",
      };
    }
    if (awaitingReview) {
      return {
        emoji: "🧾",
        title: "Pagamento em análise",
        description: "A equipe está conferindo seu envio. Assim que ele for validado, seu ciclo seguirá normalmente.",
      };
    }
    if (paymentDone) {
      return {
        emoji: "✅",
        title: "Mensalidade atual quitada",
        description: nextUnlockLabel
          ? `Sua nova liberação abre em ${nextUnlockLabel}. Até lá, você segue com o acesso regularizado.`
          : "Seu acesso está regularizado neste momento.",
      };
    }
    if (paymentAvailable) {
      return {
        emoji: "🚀",
        title: "Novo pagamento liberado",
        description: nextDueLabel
          ? `Você já pode antecipar o próximo ciclo antes do vencimento em ${nextDueLabel}.`
          : "Você já pode enviar o próximo pagamento.",
      };
    }
    if (retryPayment) {
      return {
        emoji: "🔁",
        title: "Reenvio necessário",
        description: "O último envio foi recusado. Ajuste os dados e tente novamente para regularizar seu ciclo.",
      };
    }
    return {
      emoji: "💳",
      title: "Primeiro pagamento disponível",
      description: "Envie seu primeiro pagamento para iniciar o ciclo mensal e liberar o acompanhamento completo.",
    };
  }, [awaitingReview, nextDueLabel, nextUnlockLabel, paymentAvailable, paymentDone, paymentSectionReady, retryPayment]);

  function handleCopy(text) {
    navigator.clipboard.writeText(text);
    setMessage("Copiado!");
  }

  async function handleAuth(event) {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    try {
      const endpoint = authType === "login" ? "/auth/login" : "/auth/register";
      const payload =
        authType === "login"
          ? { email: authForm.email, password: authForm.password }
          : { name: authForm.name, email: authForm.email, phone: authForm.phone, password: authForm.password };
      const { data } = await api.post(endpoint, payload);
      setToken(data.token);
      setUser(data.user);
      localStorage.setItem("token", data.token);
      localStorage.setItem("user", JSON.stringify(data.user));
      setMessage("Acesso liberado com sucesso.");
    } catch (error) {
      setMessage(error.response?.data?.message || "Erro de autenticação.");
    } finally {
      setLoading(false);
    }
  }

  async function submitFeedback(event) {
    event.preventDefault();
    const messageText = feedbackForm.trim();
    if (messageText.length < 6) {
      setMessage("Escreva uma sugestão com pelo menos 6 caracteres.");
      return;
    }

    setFeedbackSending(true);
    setMessage("");
    try {
      const { data } = await api.post("/feedbacks", { message: messageText });
      setFeedbackForm("");
      setMessage(data.message || "Feedback enviado com sucesso.");
    } catch (error) {
      setMessage(error.response?.data?.message || "Não foi possível enviar sua sugestão.");
    } finally {
      setFeedbackSending(false);
    }
  }

  async function loadMyPayments() {
    setPaymentsLoaded(false);
    const { data } = await api.get("/payments/my");
    if (Array.isArray(data)) {
      setPayments(data);
      setPaymentAvailability(null);
      setPaymentsLoaded(true);
      return;
    }

    setPayments(data.payments || []);
    setPaymentAvailability(data.availability || null);
    setPaymentsLoaded(true);
  }

  async function loadDashboard(period = dashboardPeriod) {
    const { data } = await api.get("/admin/dashboard", { params: { period } });
    setDashboard(data);
  }

  async function createPayment(event) {
    event.preventDefault();
    if (payForm.paymentMethod === "pix" && !payForm.proof) {
      setMessage("Para PIX, anexe o comprovante.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      let payerName = String(user?.name || "").trim();
      if (!payerName) {
        const { data: me } = await api.get("/me");
        payerName = String(me?.name || "").trim();
        if (payerName) {
          setUser((prev) => {
            const nextUser = { ...(prev || {}), ...me };
            localStorage.setItem("user", JSON.stringify(nextUser));
            return nextUser;
          });
        }
      }

      const submittedMethod = payForm.paymentMethod;
      const body = new FormData();
      body.append("userName", payerName);
      body.append("paymentMethod", payForm.paymentMethod);
      if (payForm.paymentMethod === "pix" && payForm.proof) body.append("proof", payForm.proof);
      const { data } = await api.post("/payments", body);
      setMessage(data.message || "Obrigado! Seu pagamento será analisado.");
      setPaymentCelebration({
        title: submittedMethod === "cash" ? "Pagamento registrado 💸" : "Comprovante enviado 🎉",
        subtitle:
          submittedMethod === "cash"
            ? "Seu pedido foi enviado para análise e a equipe vai confirmar o pagamento em dinheiro."
            : "Agora a equipe vai conferir o comprovante para validar o seu próximo ciclo.",
      });
      setPayForm({ proof: null, paymentMethod: "pix" });
      await loadMyPayments();
    } catch (error) {
      setMessage(error.response?.data?.message || "Não foi possível registrar o pagamento.");
      await loadMyPayments();
    } finally {
      setLoading(false);
    }
  }

  async function updateStatus(id, status) {
    await api.patch(`/payments/${id}/status`, { status });
    await loadDashboard();
  }

  async function uploadAdminProof(paymentId) {
    if (!adminProofFile) {
      setMessage("Selecione um arquivo para anexar.");
      return;
    }
    const body = new FormData();
    body.append("proof", adminProofFile);
    await api.patch(`/payments/${paymentId}/admin-proof`, body);
    setAdminProofFile(null);
    setSelectedPaymentId(null);
    setMessage("Comprovante anexado pela administração.");
    await loadDashboard();
  }

  async function resetUserPassword(userId) {
    const newPassword = window.prompt("Digite a nova senha do usuário:");
    if (!newPassword) return;
    await api.patch(`/admin/users/${userId}/password`, { newPassword });
    setMessage("Senha redefinida com sucesso.");
  }

  async function deleteUser(userId) {
    const confirmed = window.confirm(
      "Deseja realmente excluir este cadastro? Isso também remove os pagamentos do usuário."
    );
    if (!confirmed) return;
    await api.delete(`/admin/users/${userId}`);
    setMessage("Cadastro excluído com sucesso.");
    await loadDashboard();
  }

  function openProof(filePath) {
    const base = api.defaults.baseURL || "/api";
    const origin =
      base.startsWith("http") && !base.includes(window.location.host)
        ? base.replace(/\/api\/?$/, "")
        : window.location.origin;
    const url = `${origin}${filePath.startsWith("/") ? "" : "/"}${filePath}`;
    const isImage = /\.(png|jpe?g|gif|webp)$/i.test(filePath);
    if (isImage) {
      setPreviewImage(url);
      return;
    }
    window.open(url, "_blank");
  }

  function logout() {
    setToken("");
    setUser(null);
    setDashboard(null);
    setPayments([]);
    setPaymentsLoaded(false);
    setPaymentAvailability(null);
    localStorage.removeItem("token");
    localStorage.removeItem("user");
  }

  return (
    <div className={`layout ${telaClass}`}>
      <div className="fume" />
      <header className="hero">
        <img src="/images/logo-casa-estudante.png" alt="Logo Casa do Estudante" className="logo" />
        <div>
          <h1>Departamento de Esportes da Casa do Estudante do Ceará</h1>
          <p>Buscando a melhoria constante</p>
        </div>
      </header>

      {!token && (
        <section className="card auth glass">
          <div className="switch">
            <button type="button" className={authType === "login" ? "active" : ""} onClick={() => setAuthType("login")}>
              Entrar
            </button>
            <button
              type="button"
              className={authType === "register" ? "active" : ""}
              onClick={() => setAuthType("register")}
            >
              Criar conta
            </button>
          </div>
          <form onSubmit={handleAuth}>
            {authType === "register" && (
              <input
                placeholder="Nome completo"
                value={authForm.name}
                onChange={(e) => setAuthForm((p) => ({ ...p, name: e.target.value }))}
                required
              />
            )}
            <input
              placeholder="E-mail"
              type="email"
              value={authForm.email}
              onChange={(e) => setAuthForm((p) => ({ ...p, email: e.target.value }))}
              required
            />
            {authType === "register" && (
              <input
                placeholder="Telefone (WhatsApp)"
                value={authForm.phone}
                onChange={(e) => setAuthForm((p) => ({ ...p, phone: e.target.value }))}
                required
              />
            )}
            <input
              placeholder="Senha"
              type="password"
              value={authForm.password}
              onChange={(e) => setAuthForm((p) => ({ ...p, password: e.target.value }))}
              required
            />
            <button className="btn-block" type="submit" disabled={loading}>
              {loading ? "Processando…" : "Entrar no sistema"}
            </button>
          </form>
          <p className="hint">Esqueceu a senha? Entre em contato com o coordenador.</p>
        </section>
      )}

      {token && !isAdmin && (
        <>
          <section className="grid user-grid">
            <article className="card glass payment-card">
              <div className={`payment-layout ${canStartPayment ? "payment-layout--interactive" : ""}`}>
                {canStartPayment && (
                  <div className="payment-form-panel">
                    <div className="payment-form-panel-header">
                      <span className="payment-method-label">Forma de pagamento</span>
                      <div className="pay-method-row">
                        <button
                          type="button"
                          className={payForm.paymentMethod === "pix" ? "active" : ""}
                          onClick={() => setPayForm((p) => ({ ...p, paymentMethod: "pix" }))}
                        >
                          PIX
                        </button>
                        <button
                          type="button"
                          className={payForm.paymentMethod === "cash" ? "active" : ""}
                          onClick={() => setPayForm((p) => ({ ...p, paymentMethod: "cash", proof: null }))}
                        >
                          Dinheiro
                        </button>
                      </div>
                    </div>

                    {payForm.paymentMethod === "pix" ? (
                      <div className="pix-box">
                        <p className="chave-pix">
                          <strong>Chave PIX:</strong> 621.669.183-01
                        </p>
                        <button type="button" onClick={() => handleCopy("621.669.183-01")}>
                          Copiar chave PIX 📋
                        </button>
                      </div>
                    ) : (
                      <p className="hint compact-hint">
                        Pagamento em dinheiro não exige comprovante digital. Confirme abaixo para registrar o pedido de
                        análise.
                      </p>
                    )}

                    <form className="payment-form" onSubmit={createPayment}>
                      {payForm.paymentMethod === "pix" && (
                        <input
                          type="file"
                          accept="image/*,.pdf"
                          required
                          onChange={(e) => setPayForm((p) => ({ ...p, proof: e.target.files?.[0] || null }))}
                        />
                      )}
                      <button className="btn-block" type="submit" disabled={loading}>
                        {payForm.paymentMethod === "cash"
                          ? "Confirmar pagamento em dinheiro 💸"
                          : "Enviar comprovante PIX ✨"}
                      </button>
                    </form>
                  </div>
                )}

                <div className="payment-overview">
                  <div className="payment-section-title">
                    <div>
                      <h2>Pagamento da mensalidade</h2>
                      <p className="hint">Acompanhe sua situação atual, a próxima liberação e o prazo do seu acesso.</p>
                    </div>
                  </div>

                  {!paymentSectionReady && <p className="hint">Carregando situação do pagamento...</p>}

                  {paymentSectionReady && (
                    <>
                      <div className="payment-hero">
                        <span className="payment-hero-emoji" aria-hidden="true">
                          {paymentHero.emoji}
                        </span>
                        <div>
                          <strong>{paymentHero.title}</strong>
                          <p>{paymentHero.description}</p>
                        </div>
                      </div>

                      <div className="payment-info-grid">
                        <div className="payment-info-card">
                          <span>🔓 Próxima liberação</span>
                          <strong>
                            {nextUnlockLabel ||
                              (paymentAvailable || retryPayment || currentPaymentStatus === "first_payment"
                                ? "Disponível agora"
                                : "Aguardando confirmação")}
                          </strong>
                        </div>
                        <div className="payment-info-card">
                          <span>🏋️ Você pode treinar até</span>
                          <strong>{trainingUntilLabel || "Após a confirmação do primeiro pagamento"}</strong>
                        </div>
                        <div className="payment-info-card">
                          <span>📌 Situação atual</span>
                          <strong>{paymentSituationLabel}</strong>
                        </div>
                      </div>

                      {retryPayment && (
                        <p className="status-message">O envio anterior foi recusado. Corrija os dados e tente novamente.</p>
                      )}
                    </>
                  )}
                </div>
              </div>
            </article>

            <article className="card glass">
              <div className="row-between">
                <h2>Histórico de pagamentos</h2>
                <button onClick={logout}>Sair</button>
              </div>
              {payments.length === 0 ? (
                <p className="empty-hint">Nenhum pagamento enviado ainda.</p>
              ) : (
                <ul className="list">
                  {payments.map((payment) => (
                    <li key={payment.id}>
                      <div className="list-primary">
                        <span className="badge-method">{payment.payment_method === "cash" ? "Dinheiro" : "PIX"}</span>
                        <span className="list-text">
                          {monthTitlePt(payment.month_ref)} — {money(payment.amount)} — {formatDatePt(payment.created_at)}
                        </span>
                      </div>
                      <strong className={`status ${payment.status}`}>{statusLabel[payment.status] || payment.status}</strong>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          </section>

          <section className="user-footer-section">
            <article className="card glass feedback-card">
              <div className="row-between feedback-heading">
                <div>
                  <h2>Perguntas e sugestões 💡</h2>
                  <p className="hint">
                    Como você quer que esse dinheiro seja gasto? Sua ideia ajuda a priorizar melhorias para quem treina.
                  </p>
                </div>
              </div>
              <form className="feedback-form" onSubmit={submitFeedback}>
                <textarea
                  placeholder="Ex.: investir em bolas novas, melhorar a iluminação, comprar equipamentos, reforçar a manutenção ou ampliar horários."
                  value={feedbackForm}
                  onChange={(e) => setFeedbackForm(e.target.value)}
                  minLength={6}
                  maxLength={500}
                  rows={4}
                  required
                />
                <div className="feedback-actions">
                  <p className="hint">Sua mensagem vai direto para o painel administrativo.</p>
                  <button type="submit" disabled={feedbackSending}>
                    {feedbackSending ? "Enviando..." : "Enviar sugestão ✨"}
                  </button>
                </div>
              </form>
            </article>
          </section>
        </>
      )}

      {token && isAdmin && dashboard && (
        <section className="admin">
          <div className="admin-title-bar row-between">
            <h2>Dashboard administrativo</h2>
            <button type="button" onClick={logout}>
              Sair
            </button>
          </div>

          <div className="kpis">
            <div className="card glass">
              <h3>{dashboardPeriodLabel.payersTitle}</h3>
              <p>{dashboard.paidCount}</p>
            </div>
            <div className="card glass">
              <h3>{dashboardPeriodLabel.revenueTitle}</h3>
              <p>{money(dashboard.monthlyRevenue)}</p>
            </div>
            <div className="card glass">
              <h3>Usuários cadastrados</h3>
              <p>{dashboard.users.filter((u) => u.role === "user").length}</p>
            </div>
          </div>

          <article className="card chart glass card-overflow-visible">
            <div className="row-between chart-head">
              <h3>Receita por dia</h3>
              <HoverMenu label="Período" align="end">
                <div className="menu-list-inner menu-list-scroll">
                  <div className="menu-section-label">Intervalos</div>
                  <button type="button" onClick={() => setDashboardPeriod("month")}>
                    Último mês (aprox. 30 dias)
                  </button>
                  <button type="button" onClick={() => setDashboardPeriod("6months")}>
                    Últimos 6 meses
                  </button>
                  <button type="button" onClick={() => setDashboardPeriod("year")}>
                    Último ano
                  </button>
                  {(dashboard.monthsWithData?.length || 0) > 0 && (
                    <>
                      <div className="menu-section-label">Mês específico (com registros)</div>
                      {dashboard.monthsWithData.map((ym) => (
                        <button key={ym} type="button" onClick={() => setDashboardPeriod(ym)}>
                          {monthTitlePt(ym)}
                        </button>
                      ))}
                    </>
                  )}
                </div>
              </HoverMenu>
            </div>
            <p className="hint">{dashboardPeriodLabel.chartSubtitle}</p>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="dia" />
                <YAxis />
                <Tooltip />
                <Bar dataKey="valor" fill="#1a2f86" radius={[8, 8, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </article>

          <article className="card glass card-overflow-visible">
            <div className="row-between">
              <h3>Comprovantes de pagamento</h3>
              <HoverMenu label="Filtro" align="end">
                <div className="menu-list-inner">
                  <button type="button" onClick={() => setPaymentFilter("all")}>
                    Todos
                  </button>
                  <button type="button" onClick={() => setPaymentFilter("pending")}>
                    Pendentes
                  </button>
                  <button type="button" onClick={() => setPaymentFilter("paid")}>
                    Pagos
                  </button>
                  <button type="button" onClick={() => setPaymentFilter("rejected")}>
                    Recusados
                  </button>
                </div>
              </HoverMenu>
            </div>
            {filteredForms.length === 0 ? (
              <p className="empty-hint">
                {!dashboard.forms?.length
                  ? "Nenhum formulário no período selecionado."
                  : "Nenhum resultado para este filtro. Escolha outro status ou altere o período no gráfico acima."}
              </p>
            ) : (
              <ul className="list">
                {visibleForms.map((item) => (
                  <li key={item.id}>
                    <div className="list-primary">
                      <span className="badge-method">{item.payment_method === "cash" ? "Dinheiro" : "PIX"}</span>
                      <span className="list-text">
                        {item.user_name} — {monthTitlePt(item.month_ref)} — {formatDatePt(item.created_at)}
                      </span>
                    </div>
                    <div className="proof-actions">
                      <HoverMenu label="…" align="end" triggerClassName="dots-trigger">
                        <div className="menu-list-inner">
                          <button type="button" onClick={() => handleCopy(item.email)}>
                            Copiar e-mail
                          </button>
                          {item.phone && (
                            <button type="button" onClick={() => handleCopy(item.phone)}>
                              Copiar telefone
                            </button>
                          )}
                          {item.proof_file && (
                            <button type="button" onClick={() => openProof(item.proof_file)}>
                              Ver anexo do aluno
                            </button>
                          )}
                          {item.admin_proof_file && (
                            <button type="button" onClick={() => openProof(item.admin_proof_file)}>
                              Ver anexo da administração
                            </button>
                          )}
                          <button type="button" onClick={() => setSelectedPaymentId(item.id)}>
                            Anexar comprovante (admin)
                          </button>
                        </div>
                      </HoverMenu>
                    </div>
                    {item.status === "pending" || item.status === "draft" ? (
                      <div className="actions">
                        <button onClick={() => updateStatus(item.id, "paid")}>Aprovar</button>
                        <button onClick={() => updateStatus(item.id, "rejected")}>Rejeitar</button>
                      </div>
                    ) : (
                      <strong className={`status ${item.status}`}>{statusLabel[item.status] || item.status}</strong>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {filteredForms.length > 3 && (
              <button type="button" onClick={() => setShowAllForms((prev) => !prev)}>
                {showAllForms ? "Ver menos" : "Ver mais"}
              </button>
            )}
          </article>

          <article className="card glass card-overflow-visible">
            <div className="row-between">
              <h3>Usuários e situação do pagamento</h3>
              <HoverMenu label="Filtro" align="end">
                <div className="menu-list-inner">
                  <button type="button" onClick={() => setUserStatusFilter("all")}>
                    Todos
                  </button>
                  <button type="button" onClick={() => setUserStatusFilter("pending")}>
                    Pagamento pendente
                  </button>
                  <button type="button" onClick={() => setUserStatusFilter("active")}>
                    Plano ativo
                  </button>
                  <button type="button" onClick={() => setUserStatusFilter("late")}>
                    Atrasados
                  </button>
                  <button type="button" onClick={() => setUserStatusFilter("inactive")}>
                    Inativos
                  </button>
                </div>
              </HoverMenu>
            </div>
            {visibleUsers.length === 0 ? (
              <p className="empty-hint">
                {normalizedUsers.length === 0
                  ? "Nenhum usuário cadastrado."
                  : "Nenhum usuário encontrado para este filtro."}
              </p>
            ) : (
              <ul className="list">
                {visibleUsers.map((u) => {
                  return (
                    <li key={u.id}>
                      <div className="list-primary">
                        <span className="list-text">{u.name} — {describeUserPayment(u)}</span>
                      </div>
                      <div className="proof-actions">
                        <HoverMenu label="…" align="end" triggerClassName="dots-trigger">
                          <div className="menu-list-inner">
                            <button type="button" onClick={() => handleCopy(u.email)}>
                              Copiar e-mail
                            </button>
                            {u.phone && (
                              <button type="button" onClick={() => handleCopy(u.phone)}>
                                Copiar telefone
                              </button>
                            )}
                            <button type="button" onClick={() => resetUserPassword(u.id)}>
                              Redefinir senha
                            </button>
                            <button type="button" onClick={() => deleteUser(u.id)}>
                              Excluir cadastro
                            </button>
                          </div>
                        </HoverMenu>
                      </div>
                      <strong className={`status ${planStatusTone(u.plan_status)}`}>
                        {planStatusLabel(u.plan_status)}
                      </strong>
                    </li>
                  );
                })}
              </ul>
            )}
            {filteredUsers.length > 3 && (
              <button type="button" onClick={() => setShowAllUsers((prev) => !prev)}>
                {showAllUsers ? "Ver menos" : "Ver mais"}
              </button>
            )}
          </article>

          <article className="card glass card-overflow-visible">
            <div className="row-between">
              <h3>Feedbacks e perguntas 💬</h3>
              <p className="hint">Últimas ideias enviadas pelos alunos</p>
            </div>
            {visibleFeedbacks.length === 0 ? (
              <p className="empty-hint">Ainda não há sugestões enviadas pelos usuários.</p>
            ) : (
              <ul className="list feedback-list">
                {visibleFeedbacks.map((item) => (
                  <li key={item.id}>
                    <div className="list-primary feedback-primary">
                      <span className="feedback-bubble" aria-hidden="true">
                        💬
                      </span>
                      <div className="feedback-content">
                        <strong>{item.user_name}</strong>
                        <span className="feedback-meta">{formatDateTimePt(item.created_at)}</span>
                        <p className="feedback-message">{item.message}</p>
                      </div>
                    </div>
                    <div className="proof-actions">
                      <HoverMenu label="…" align="end" triggerClassName="dots-trigger">
                        <div className="menu-list-inner">
                          <button type="button" onClick={() => handleCopy(item.email)}>
                            Copiar e-mail
                          </button>
                          {item.phone && (
                            <button type="button" onClick={() => handleCopy(item.phone)}>
                              Copiar telefone
                            </button>
                          )}
                        </div>
                      </HoverMenu>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {(dashboard.feedbacks?.length || 0) > 3 && (
              <button type="button" onClick={() => setShowAllFeedbacks((prev) => !prev)}>
                {showAllFeedbacks ? "Ver menos" : "Ver mais"}
              </button>
            )}
          </article>
        </section>
      )}

      <AnimatePresence>
        {message && (
          <motion.div
            className="toast"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
          >
            {message}
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {paymentCelebration && (
          <motion.div
            className="payment-celebration"
            initial={{ opacity: 0, scale: 0.92, y: 18 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: 18 }}
          >
            <div className="payment-celebration-burst" aria-hidden="true">
              {["🎉", "✨", "💙", "🏋️", "💸"].map((emoji, index) => (
                <motion.span
                  key={`${emoji}-${index}`}
                  className="payment-celebration-emoji"
                  initial={{ opacity: 0, y: 16, scale: 0.7, rotate: -10 }}
                  animate={{ opacity: [0, 1, 0.92], y: [16, -14, -26], scale: [0.7, 1.08, 1], rotate: [-10, 8, 0] }}
                  exit={{ opacity: 0, y: -32, scale: 0.6 }}
                  transition={{ duration: 1.5, delay: index * 0.06 }}
                >
                  {emoji}
                </motion.span>
              ))}
            </div>
            <strong>{paymentCelebration.title}</strong>
            <p>{paymentCelebration.subtitle}</p>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {previewImage && (
          <motion.div className="modal-bg" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div
              className="modal-box"
              initial={{ y: 30, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 30, opacity: 0 }}
            >
              <button type="button" onClick={() => setPreviewImage("")}>
                Fechar
              </button>
              <img src={previewImage} alt="Comprovante anexado" />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {selectedPaymentId && (
          <motion.div className="modal-bg" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div
              className="modal-box"
              initial={{ y: 30, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 30, opacity: 0 }}
            >
              <h3>Anexar comprovante (administração)</h3>
              <input type="file" accept="image/*,.pdf" onChange={(e) => setAdminProofFile(e.target.files?.[0] || null)} />
              <div className="actions">
                <button type="button" onClick={() => uploadAdminProof(selectedPaymentId)}>
                  Salvar anexo
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedPaymentId(null);
                    setAdminProofFile(null);
                  }}
                >
                  Cancelar
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default App;

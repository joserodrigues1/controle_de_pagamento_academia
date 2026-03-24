import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import axios from "axios";
import { AnimatePresence, motion } from "framer-motion";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

/** Em dev o Vite encaminha /api para o backend. Em produção o Express serve site + API na mesma origem. */
const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || "/api",
});

const MotionDiv = motion.div;
const MotionSpan = motion.span;
const revealEase = [0.22, 1, 0.36, 1];

const USER_STATUS_OPTIONS = [
  { value: "pending", label: "Pagamento pendente", pdfLabel: "PENDENTE" },
  { value: "active", label: "Plano ativo", pdfLabel: "PAGO" },
  { value: "late", label: "Atrasados", pdfLabel: "ATRASADO" },
  { value: "inactive", label: "Inativos", pdfLabel: "INATIVO" },
];

const DEFAULT_USER_STATUS_FILTERS = USER_STATUS_OPTIONS.map((option) => option.value);

function formatCurrency(value) {
  return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatCount(value) {
  return Math.round(Number(value || 0)).toLocaleString("pt-BR");
}

const MAX_PHONE_DIGITS = 11;
const MAX_PHONE_MASK_LENGTH = 16;

function getPhoneDigits(value) {
  return String(value || "").replace(/\D/g, "").slice(0, MAX_PHONE_DIGITS);
}

function formatPhoneInput(value) {
  const digits = getPhoneDigits(value);
  if (!digits) return "";

  const areaCode = digits.slice(0, 2);
  const prefixDigit = digits.slice(2, 3);
  const firstBlock = digits.slice(3, 7);
  const secondBlock = digits.slice(7, 11);

  let formatted = areaCode ? `(${areaCode}` : "";
  if (areaCode.length === 2) formatted += ")";
  if (prefixDigit) formatted += ` ${prefixDigit}`;
  if (firstBlock) formatted += ` ${firstBlock}`;
  if (secondBlock) formatted += `-${secondBlock}`;

  return formatted;
}

function buildRevealMotion(delay = 0, shift = 18) {
  return {
    initial: { opacity: 0, y: shift, scale: 0.985 },
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: { opacity: 0, y: 10, scale: 0.985 },
    transition: { duration: 0.46, delay, ease: revealEase },
  };
}

function AnimatedMetricValue({ value, format = "number" }) {
  const [displayValue, setDisplayValue] = useState(0);
  const displayValueRef = useRef(0);

  useEffect(() => {
    const startValue = displayValueRef.current;
    const target = Number(value || 0);
    const duration = 720;
    let frameId = 0;
    let startedAt = 0;

    function tick(timestamp) {
      if (!startedAt) startedAt = timestamp;
      const progress = Math.min(1, (timestamp - startedAt) / duration);
      const eased = 1 - (1 - progress) ** 3;
      const nextValue = startValue + (target - startValue) * eased;
      displayValueRef.current = nextValue;
      setDisplayValue(nextValue);
      if (progress < 1) frameId = window.requestAnimationFrame(tick);
    }

    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, [value]);

  return <>{format === "currency" ? formatCurrency(displayValue) : formatCount(displayValue)}</>;
}

function todayInputValue() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function periodChipLabel(period) {
  if (/^\d{4}-\d{2}$/.test(period)) return monthTitlePt(period);
  if (period === "year") return "Último ano";
  if (period === "6months") return "Últimos 6 meses";
  return "Último mês";
}

function HoverMenu({ label, align = "end", triggerClassName = "", className = "", children }) {
  const alignClass = align === "start" ? "hover-menu--start" : "hover-menu--end";
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const closeTimeoutRef = useRef(0);
  const [isOpen, setIsOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState({});

  const clearCloseTimeout = useCallback(() => {
    if (!closeTimeoutRef.current || typeof window === "undefined") return;
    window.clearTimeout(closeTimeoutRef.current);
    closeTimeoutRef.current = 0;
  }, []);

  const openMenu = useCallback(() => {
    clearCloseTimeout();
    setIsOpen(true);
  }, [clearCloseTimeout]);

  const closeMenu = useCallback(() => {
    clearCloseTimeout();
    setIsOpen(false);
  }, [clearCloseTimeout]);

  const scheduleCloseMenu = useCallback(() => {
    clearCloseTimeout();
    if (typeof window === "undefined") {
      setIsOpen(false);
      return;
    }
    closeTimeoutRef.current = window.setTimeout(() => {
      setIsOpen(false);
      closeTimeoutRef.current = 0;
    }, 140);
  }, [clearCloseTimeout]);

  const updatePanelPosition = useCallback(() => {
    if (typeof window === "undefined" || !triggerRef.current) return;

    const rect = triggerRef.current.getBoundingClientRect();
    const nextStyle = {
      top: Math.min(window.innerHeight - 16, rect.bottom + 6),
    };

    if (align === "start") {
      nextStyle.left = Math.max(16, rect.left);
      nextStyle.right = "auto";
    } else {
      nextStyle.right = Math.max(16, window.innerWidth - rect.right);
      nextStyle.left = "auto";
    }

    setPanelStyle(nextStyle);
  }, [align]);

  useEffect(() => {
    if (!isOpen) return undefined;

    updatePanelPosition();

    function handlePointerDown(event) {
      const target = event.target;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      closeMenu();
    }

    function handleKeyDown(event) {
      if (event.key !== "Escape") return;
      closeMenu();
      triggerRef.current?.focus();
    }

    function handleViewportChange() {
      updatePanelPosition();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [closeMenu, isOpen, updatePanelPosition]);

  useEffect(() => {
    return () => {
      clearCloseTimeout();
    };
  }, [clearCloseTimeout]);

  function handleRootBlur(event) {
    const nextTarget = event.relatedTarget;
    if (rootRef.current?.contains(nextTarget) || panelRef.current?.contains(nextTarget)) return;
    scheduleCloseMenu();
  }

  function handlePanelClickCapture(event) {
    const clickableElement = event.target?.closest?.("button, a");
    if (!clickableElement || clickableElement.disabled) return;
    window.setTimeout(() => {
      closeMenu();
    }, 0);
  }

  return (
    <div
      ref={rootRef}
      className={`hover-menu ${alignClass} ${isOpen ? "is-open" : ""} ${className}`.trim()}
      onMouseEnter={openMenu}
      onMouseLeave={scheduleCloseMenu}
      onFocusCapture={openMenu}
      onBlurCapture={handleRootBlur}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`hover-menu-trigger ${triggerClassName}`.trim()}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => {
          clearCloseTimeout();
          setIsOpen((current) => !current);
        }}
      >
        {label}
      </button>
      {isOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              className="hover-menu-panel hover-menu-panel--portal is-open"
              role="menu"
              style={panelStyle}
              onMouseEnter={openMenu}
              onMouseLeave={scheduleCloseMenu}
              onClickCapture={handlePanelClickCapture}
            >
              {children}
            </div>,
            document.body
          )
        : null}
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

function formatDayMonthPt(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
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

function userStatusOptionLabel(status) {
  return USER_STATUS_OPTIONS.find((option) => option.value === status)?.label || planStatusLabel(status);
}

function planStatusPdfLabel(status) {
  return USER_STATUS_OPTIONS.find((option) => option.value === status)?.pdfLabel || String(planStatusLabel(status)).toUpperCase();
}

function summarizeUserStatusFilters(selectedStatuses) {
  if (selectedStatuses.length === 0) return "Nenhuma situação";
  if (selectedStatuses.length === USER_STATUS_OPTIONS.length) return "Todas as situações";
  return USER_STATUS_OPTIONS.filter((option) => selectedStatuses.includes(option.value))
    .map((option) => option.label)
    .join(" + ");
}

function drawUsersPdfHeader(doc, filterLine) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const title = "LISTA DE USUÁRIOS";

  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text(title, pageWidth / 2, 18, { align: "center" });

  const titleWidth = doc.getTextWidth(title);
  const titleStartX = (pageWidth - titleWidth) / 2;
  doc.setLineWidth(0.4);
  doc.line(titleStartX, 19.6, titleStartX + titleWidth, 19.6);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.text(filterLine, pageWidth / 2, 25, { align: "center" });
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
  const [userStatusFilters, setUserStatusFilters] = useState(DEFAULT_USER_STATUS_FILTERS);
  const [dashboardPeriod, setDashboardPeriod] = useState("month");
  const [adminSection, setAdminSection] = useState("dashboard");
  const [showAllForms, setShowAllForms] = useState(false);
  const [showAllUsers, setShowAllUsers] = useState(false);
  const [showAllExpenses, setShowAllExpenses] = useState(false);

  const [authForm, setAuthForm] = useState({ name: "", email: "", phone: "", password: "" });
  const [payForm, setPayForm] = useState({ proof: null, paymentMethod: "pix" });
  const [expenseForm, setExpenseForm] = useState({ title: "", description: "", amount: "", expenseDate: todayInputValue() });
  const [expenseFiles, setExpenseFiles] = useState([]);
  const [expenseFileInputKey, setExpenseFileInputKey] = useState(0);
  const [creatingExpense, setCreatingExpense] = useState(false);
  const [feedbackForm, setFeedbackForm] = useState("");
  const [feedbackSending, setFeedbackSending] = useState(false);
  const [showAllFeedbacks, setShowAllFeedbacks] = useState(false);
  const [paymentCelebration, setPaymentCelebration] = useState(null);
  const [exportingUsersPdf, setExportingUsersPdf] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [changingPassword, setChangingPassword] = useState(false);
  const [adminCreateForm, setAdminCreateForm] = useState({ name: "", email: "", phone: "", password: "" });
  const [creatingAdmin, setCreatingAdmin] = useState(false);

  const loadMyPayments = useCallback(async () => {
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
  }, []);

  const loadDashboard = useCallback(async (period = dashboardPeriod) => {
    const { data } = await api.get("/admin/dashboard", { params: { period } });
    setDashboard(data);
  }, [dashboardPeriod]);

  useEffect(() => {
    api.defaults.headers.common.Authorization = token ? `Bearer ${token}` : "";
    if (!token) return;

    let ignore = false;

    async function loadCurrentView() {
      try {
        if (user?.role === "admin") await loadDashboard(dashboardPeriod);
        else await loadMyPayments();
      } catch (error) {
        if (ignore) return;
        if (error?.response?.status === 401 || error?.response?.status === 403) {
          setToken("");
          setUser(null);
          setDashboard(null);
          setPayments([]);
          setPaymentsLoaded(false);
          setPaymentAvailability(null);
          localStorage.removeItem("token");
          localStorage.removeItem("user");
          setMessage("Sua sessão expirou. Entre novamente.");
          return;
        }
        setMessage(user?.role === "admin" ? "Não foi possível carregar o dashboard." : "Não foi possível carregar sua área.");
      }
    }

    loadCurrentView();

    return () => {
      ignore = true;
    };
  }, [dashboardPeriod, loadDashboard, loadMyPayments, token, user?.role]);

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
      } catch (error) {
        if (ignore) return;
        if (error?.response?.status === 401 || error?.response?.status === 403) {
          setToken("");
          setUser(null);
          setDashboard(null);
          setPayments([]);
          setPaymentsLoaded(false);
          setPaymentAvailability(null);
          localStorage.removeItem("token");
          localStorage.removeItem("user");
          setMessage("Sua sessão expirou. Entre novamente.");
        }
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
    if (userStatusFilters.length === 0) return [];
    if (userStatusFilters.length === USER_STATUS_OPTIONS.length) return normalizedUsers;
    return normalizedUsers.filter((userRow) => userStatusFilters.includes(userRow.plan_status));
  }, [normalizedUsers, userStatusFilters]);
  const allUserStatusesSelected = userStatusFilters.length === USER_STATUS_OPTIONS.length;
  const userStatusFilterSummary = useMemo(() => summarizeUserStatusFilters(userStatusFilters), [userStatusFilters]);
  const pdfUserStatusSummary = useMemo(() => {
    if (userStatusFilters.length === 0) return "NENHUMA SITUAÇÃO";
    if (allUserStatusesSelected) return "TODAS AS SITUAÇÕES";
    return USER_STATUS_OPTIONS.filter((option) => userStatusFilters.includes(option.value))
      .map((option) => option.pdfLabel)
      .join(" + ");
  }, [allUserStatusesSelected, userStatusFilters]);
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
  const adminAccounts = useMemo(
    () => (dashboard?.users || []).filter((userRow) => userRow.role === "admin"),
    [dashboard?.users]
  );
  const financeData = dashboard?.finance || null;
  const financeChartData = useMemo(
    () =>
      (financeData?.timeline || []).map((item) => ({
        label: item.label,
        receitas: Number(item.revenue || 0),
        gastos: Number(item.expenses || 0),
        saldo: Number(item.balance || 0),
      })),
    [financeData?.timeline]
  );
  const financeExpenses = useMemo(() => financeData?.expenses || [], [financeData?.expenses]);
  const visibleExpenses = useMemo(
    () => (showAllExpenses ? financeExpenses : financeExpenses.slice(0, 4)),
    [financeExpenses, showAllExpenses]
  );
  const dashboardPeriodChip = useMemo(() => periodChipLabel(dashboardPeriod), [dashboardPeriod]);

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
  const financePeriodLabel = useMemo(() => {
    const p = dashboardPeriod;
    if (/^\d{4}-\d{2}$/.test(p)) {
      const t = monthTitlePt(p);
      return {
        revenueTitle: `Faturamento em ${t}`,
        expenseTitle: `Gastos em ${t}`,
        balanceTitle: `Saldo em ${t}`,
        chartTitle: `Fluxo financeiro em ${t}`,
        chartSubtitle: "Entradas confirmadas e saídas lançadas, agrupadas por dia.",
      };
    }
    if (p === "year") {
      return {
        revenueTitle: "Faturamento no último ano",
        expenseTitle: "Gastos no último ano",
        balanceTitle: "Saldo do período",
        chartTitle: "Fluxo financeiro no último ano",
        chartSubtitle: "Entradas e saídas agrupadas por mês nos últimos 12 meses.",
      };
    }
    if (p === "6months") {
      return {
        revenueTitle: "Faturamento nos últimos 6 meses",
        expenseTitle: "Gastos nos últimos 6 meses",
        balanceTitle: "Saldo do período",
        chartTitle: "Fluxo financeiro nos últimos 6 meses",
        chartSubtitle: "Entradas e saídas agrupadas por mês nos últimos 6 meses.",
      };
    }
    return {
      revenueTitle: "Faturamento no último mês",
      expenseTitle: "Gastos no último mês",
      balanceTitle: "Saldo do período",
      chartTitle: "Fluxo financeiro no último mês",
      chartSubtitle: "Entradas confirmadas e saídas lançadas por dia no período recente.",
    };
  }, [dashboardPeriod]);

  const statusLabel = {
    draft: "Aguardando análise",
    pending: "Aguardando análise",
    paid: "Pago",
    rejected: "Rejeitado",
  };
  const money = formatCurrency;
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

  function toggleUserStatusFilter(status) {
    setUserStatusFilters((current) =>
      current.includes(status)
        ? current.filter((value) => value !== status)
        : USER_STATUS_OPTIONS.filter((option) => current.includes(option.value) || option.value === status).map(
            (option) => option.value
          )
    );
  }

  function selectAllUserStatusFilters() {
    setUserStatusFilters([...DEFAULT_USER_STATUS_FILTERS]);
  }

  function clearUserStatusFilters() {
    setUserStatusFilters([]);
  }

  async function downloadUsersPdf() {
    if (filteredUsers.length === 0) {
      setMessage(
        userStatusFilters.length === 0
          ? "Selecione ao menos uma situação para gerar o PDF."
          : "Não há usuários para exportar nesse filtro."
      );
      return;
    }

    setExportingUsersPdf(true);

    try {
      const [{ jsPDF }, { default: autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
      const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      const filterLine = `Situações: ${pdfUserStatusSummary}`;

      autoTable(doc, {
        startY: 31,
        margin: { top: 31, right: 8, bottom: 18, left: 8 },
        theme: "grid",
        head: [["N°", "NOME", "VÁLIDO ATÉ", "SITUAÇÃO DE PAGAMENTO"]],
        body: filteredUsers.map((userRow, index) => [
          String(index + 1),
          userRow.name || "Sem nome",
          formatDayMonthPt(userRow.next_due_at),
          planStatusPdfLabel(userRow.plan_status),
        ]),
        styles: {
          font: "helvetica",
          fontSize: 10,
          textColor: [0, 0, 0],
          lineColor: [0, 0, 0],
          lineWidth: 0.2,
          cellPadding: 2.8,
          halign: "center",
          valign: "middle",
        },
        headStyles: {
          fillColor: [255, 255, 255],
          textColor: [0, 0, 0],
          fontStyle: "bold",
          lineWidth: 0.25,
        },
        columnStyles: {
          0: { cellWidth: 12 },
          1: { cellWidth: 84, halign: "left" },
          2: { cellWidth: 35 },
          3: { cellWidth: 61 },
        },
        didParseCell: (data) => {
          if (data.section === "body" && data.column.index === 1) {
            data.cell.styles.fontStyle = "bold";
          }
        },
        didDrawPage: () => {
          drawUsersPdfHeader(doc, filterLine);
        },
      });

      doc.setPage(doc.getNumberOfPages());
      const pageHeight = doc.internal.pageSize.getHeight();
      const pageWidth = doc.internal.pageSize.getWidth();
      const finalY = doc.lastAutoTable?.finalY ?? 31;

      if (pageHeight - finalY < 38) {
        doc.addPage();
        doc.setPage(doc.getNumberOfPages());
        drawUsersPdfHeader(doc, filterLine);
      }

      const footerDate = new Date().toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "long",
        year: "numeric",
      });

      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      doc.text(
        [
          `Fortaleza - CE, ${footerDate}`,
          "Casa do Estudante do Ceará",
          "Departamento de esportes & academia",
        ],
        pageWidth - 12,
        doc.internal.pageSize.getHeight() - 26,
        { align: "right" }
      );

      const fileFilterKey =
        userStatusFilters.length === 0 ? "sem-situacao" : allUserStatusesSelected ? "todos" : userStatusFilters.join("-");
      const fileDate = new Date().toISOString().slice(0, 10);

      doc.save(`lista-usuarios-${fileFilterKey}-${fileDate}.pdf`);
      setMessage("PDF gerado com sucesso.");
    } catch {
      setMessage("Não foi possível gerar o PDF.");
    } finally {
      setExportingUsersPdf(false);
    }
  }

  async function handleAuth(event) {
    event.preventDefault();

    if (authType === "register" && getPhoneDigits(authForm.phone).length !== MAX_PHONE_DIGITS) {
      setMessage("Informe o telefone no formato (85) 9 9850-6905.");
      return;
    }

    setLoading(true);
    setMessage("");
    try {
      const endpoint = authType === "login" ? "/auth/login" : "/auth/register";
      const payload =
        authType === "login"
          ? { email: authForm.email, password: authForm.password }
          : {
              name: authForm.name,
              email: authForm.email,
              phone: formatPhoneInput(authForm.phone),
              password: authForm.password,
            };
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
    const newPassword = window.prompt("Digite a nova senha do usuário (mínimo 8 caracteres, com letras e números):");
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

  async function changeOwnPassword(event) {
    event.preventDefault();
    const currentPassword = passwordForm.currentPassword;
    const newPassword = passwordForm.newPassword;
    const confirmPassword = passwordForm.confirmPassword;

    if (!currentPassword || !newPassword || !confirmPassword) {
      setMessage("Preencha a senha atual, a nova senha e a confirmação.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setMessage("A confirmação da nova senha não confere.");
      return;
    }

    setChangingPassword(true);
    setMessage("");

    try {
      const { data } = await api.patch("/auth/password", { currentPassword, newPassword });
      setPasswordForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
      setMessage(data.message || "Senha atualizada com sucesso.");
    } catch (error) {
      setMessage(error.response?.data?.message || "Não foi possível atualizar sua senha.");
    } finally {
      setChangingPassword(false);
    }
  }

  async function createAdminAccount(event) {
    event.preventDefault();
    const name = adminCreateForm.name.trim();
    const email = adminCreateForm.email.trim();
    const phoneDigits = getPhoneDigits(adminCreateForm.phone);
    const phone = phoneDigits.length ? formatPhoneInput(adminCreateForm.phone) : "";
    const password = adminCreateForm.password;

    if (!name || !email || !password) {
      setMessage("Preencha nome, e-mail e senha do novo administrador.");
      return;
    }
    if (phoneDigits.length && phoneDigits.length !== MAX_PHONE_DIGITS) {
      setMessage("Informe o telefone no formato (85) 9 9850-6905.");
      return;
    }

    setCreatingAdmin(true);
    setMessage("");

    try {
      const { data } = await api.post("/admin/users", { name, email, phone, password });
      setAdminCreateForm({ name: "", email: "", phone: "", password: "" });
      setMessage(data.message || "Administrador criado com sucesso.");
      await loadDashboard();
    } catch (error) {
      setMessage(error.response?.data?.message || "Não foi possível criar o administrador.");
    } finally {
      setCreatingAdmin(false);
    }
  }

  function handleExpenseFilesChange(event) {
    const selectedFiles = Array.from(event.target.files || []);
    if (selectedFiles.length > 10) {
      setExpenseFiles([]);
      setExpenseFileInputKey((current) => current + 1);
      setMessage("Você pode anexar no máximo 10 comprovantes por gasto.");
      return;
    }
    setExpenseFiles(selectedFiles);
  }

  async function createExpense(event) {
    event.preventDefault();
    const title = expenseForm.title.trim();
    const description = expenseForm.description.trim();
    const amount = expenseForm.amount.trim();
    const expenseDate = expenseForm.expenseDate || todayInputValue();

    if (!title || !amount) {
      setMessage("Preencha ao menos o título e o valor do gasto.");
      return;
    }
    if (expenseFiles.length > 10) {
      setMessage("Você pode anexar no máximo 10 comprovantes por gasto.");
      return;
    }

    setCreatingExpense(true);
    setMessage("");

    try {
      const body = new FormData();
      body.append("title", title);
      body.append("description", description);
      body.append("amount", amount);
      body.append("expenseDate", expenseDate);
      expenseFiles.forEach((file) => body.append("receipts", file));

      const { data } = await api.post("/admin/expenses", body);
      setExpenseForm({ title: "", description: "", amount: "", expenseDate: todayInputValue() });
      setExpenseFiles([]);
      setExpenseFileInputKey((current) => current + 1);
      setMessage(data.message || "Gasto registrado com sucesso.");
      await loadDashboard();
    } catch (error) {
      setMessage(error.response?.data?.message || "Não foi possível registrar o gasto.");
    } finally {
      setCreatingExpense(false);
    }
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
    setAdminSection("dashboard");
    localStorage.removeItem("token");
    localStorage.removeItem("user");
  }

  return (
    <div className={`layout ${telaClass}`}>
      <div className="fume">
        <MotionDiv
          className="ambient-orb ambient-orb--one"
          animate={{ x: [0, 24, -18, 0], y: [0, -18, 22, 0], scale: [1, 1.06, 0.96, 1] }}
          transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }}
        />
        <MotionDiv
          className="ambient-orb ambient-orb--two"
          animate={{ x: [0, -22, 16, 0], y: [0, 26, -14, 0], scale: [1, 0.94, 1.08, 1] }}
          transition={{ duration: 20, repeat: Infinity, ease: "easeInOut" }}
        />
        <MotionDiv
          className="ambient-orb ambient-orb--three"
          animate={{ x: [0, 20, -12, 0], y: [0, 18, -24, 0], scale: [1, 1.04, 0.98, 1] }}
          transition={{ duration: 16, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>
      <MotionDiv {...buildRevealMotion(0.03, -14)}>
        <header className="hero">
          <img src="/images/logo-casa-estudante.png" alt="Logo Casa do Estudante" className="logo" />
          <div>
            <h1>Departamento de Esportes da Casa do Estudante do Ceará</h1>
            <p>Buscando a melhoria constante</p>
          </div>
        </header>
      </MotionDiv>

      {!token && (
        <MotionDiv className="card auth glass" {...buildRevealMotion(0.08, 20)}>
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
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                maxLength={MAX_PHONE_MASK_LENGTH}
                value={authForm.phone}
                onChange={(e) => setAuthForm((p) => ({ ...p, phone: formatPhoneInput(e.target.value) }))}
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
        </MotionDiv>
      )}

      {token && !isAdmin && (
        <>
          <MotionDiv className="grid user-grid" {...buildRevealMotion(0.08, 18)}>
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
          </MotionDiv>

          <MotionDiv className="user-footer-section" {...buildRevealMotion(0.12, 18)}>
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
          </MotionDiv>
        </>
      )}

      {token && isAdmin && dashboard && (
        <section className="admin">
          <MotionDiv className="admin-title-bar" {...buildRevealMotion(0.05, 14)}>
            <div className="admin-title-copy">
              <h2>{adminSection === "finance" ? "Gastos e controle financeiro" : "Dashboard administrativo"}</h2>
              <p className="hint">
                {adminSection === "finance"
                  ? "Registre saídas, acompanhe comprovantes permanentes e monitore o saldo real da conta."
                  : "Acompanhe pagamentos, usuários, aprovações e feedbacks em um só lugar."}
              </p>
            </div>
            <div className="admin-toolbar">
              <HoverMenu label={`Período: ${dashboardPeriodChip}`} align="end" className="hover-menu--overlay">
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
              <button type="button" onClick={logout}>
                Sair
              </button>
            </div>
          </MotionDiv>

          <MotionDiv className="admin-nav" {...buildRevealMotion(0.08, 12)}>
            <button
              type="button"
              className={adminSection === "dashboard" ? "active" : ""}
              onClick={() => setAdminSection("dashboard")}
            >
              Dashboard
            </button>
            <button
              type="button"
              className={adminSection === "finance" ? "active" : ""}
              onClick={() => setAdminSection("finance")}
            >
              Gastos e financeiro
            </button>
          </MotionDiv>

          <AnimatePresence mode="wait" initial={false}>
            {adminSection === "dashboard" ? (
              <MotionDiv key="dashboard-section" className="admin-panel-stack" {...buildRevealMotion(0.1, 16)}>
                <div className="kpis">
                  <div className="card glass">
                    <h3>{dashboardPeriodLabel.payersTitle}</h3>
                    <p className="metric-value"><AnimatedMetricValue value={dashboard.paidCount} /></p>
                  </div>
                  <div className="card glass">
                    <h3>{dashboardPeriodLabel.revenueTitle}</h3>
                    <p className="metric-value"><AnimatedMetricValue value={dashboard.monthlyRevenue} format="currency" /></p>
                  </div>
                  <div className="card glass">
                    <h3>Usuários cadastrados</h3>
                    <p className="metric-value"><AnimatedMetricValue value={dashboard.users.filter((u) => u.role === "user").length} /></p>
                  </div>
                </div>

                <article className="card chart glass card-overflow-visible">
                  <div className="row-between chart-head">
                    <h3>Receita por dia</h3>
                  </div>
                  <p className="hint">{dashboardPeriodLabel.chartSubtitle}</p>
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="dia" />
                      <YAxis />
                      <Tooltip formatter={(value) => money(value)} />
                      <Bar dataKey="valor" fill="#1a2f86" radius={[8, 8, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </article>

                <article className="card glass card-overflow-visible">
                  <div className="row-between">
                    <h3>Comprovantes de pagamento</h3>
                    <HoverMenu label="Filtro" align="end" className="hover-menu--overlay">
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
                        : "Nenhum resultado para este filtro. Escolha outro status ou altere o período acima."}
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
                  <div className="users-card-header">
                    <div className="users-card-heading">
                      <h3>Usuários e situação do pagamento</h3>
                      <p className="hint">Exibindo: {userStatusFilterSummary}</p>
                    </div>
                    <div className="users-card-actions">
                      <HoverMenu label="Filtrar situações" align="end" className="hover-menu--overlay">
                        <div className="menu-list-inner">
                          <div className="filter-menu-actions">
                            <button
                              type="button"
                              className={`filter-quick-button ${allUserStatusesSelected ? "active" : ""}`}
                              onClick={selectAllUserStatusFilters}
                            >
                              Todas as situações
                            </button>
                            <button
                              type="button"
                              className={`filter-quick-button ${userStatusFilters.length === 0 ? "active" : ""}`}
                              onClick={clearUserStatusFilters}
                            >
                              Limpar seleção
                            </button>
                          </div>
                          <span className="menu-section-label">Usar na lista e no PDF</span>
                          <div className="filter-toggle-group">
                            {USER_STATUS_OPTIONS.map((option) => {
                              const isSelected = userStatusFilters.includes(option.value);
                              return (
                                <button
                                  key={option.value}
                                  type="button"
                                  className={`filter-toggle-button ${isSelected ? "active" : ""}`}
                                  aria-pressed={isSelected}
                                  onClick={() => toggleUserStatusFilter(option.value)}
                                >
                                  <span>{userStatusOptionLabel(option.value)}</span>
                                  <strong>{isSelected ? "✓" : "+"}</strong>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </HoverMenu>
                      <button type="button" onClick={downloadUsersPdf} disabled={exportingUsersPdf || filteredUsers.length === 0}>
                        {exportingUsersPdf ? "Gerando PDF..." : "Baixar PDF"}
                      </button>
                    </div>
                  </div>
                  {visibleUsers.length === 0 ? (
                    <p className="empty-hint">
                      {userStatusFilters.length === 0
                        ? "Selecione pelo menos uma situação para listar usuários."
                        : normalizedUsers.length === 0
                        ? "Nenhum usuário cadastrado."
                        : "Nenhum usuário encontrado para este filtro."}
                    </p>
                  ) : (
                    <ul className="list">
                      {visibleUsers.map((u) => (
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
                      ))}
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
              </MotionDiv>
            ) : (
              <MotionDiv key="finance-section" className="admin-panel-stack" {...buildRevealMotion(0.1, 16)}>
              <div className="kpis">
                <div className="card glass">
                  <h3>{financePeriodLabel.revenueTitle}</h3>
                  <p className="metric-value"><AnimatedMetricValue value={financeData?.periodRevenue} format="currency" /></p>
                </div>
                <div className="card glass">
                  <h3>{financePeriodLabel.expenseTitle}</h3>
                  <p className="metric-value"><AnimatedMetricValue value={financeData?.periodExpenses} format="currency" /></p>
                </div>
                <div className="card glass">
                  <h3>{financePeriodLabel.balanceTitle}</h3>
                  <p className="metric-value"><AnimatedMetricValue value={financeData?.periodBalance} format="currency" /></p>
                </div>
                <div className="card glass">
                  <h3>Total em conta</h3>
                  <p className="metric-value"><AnimatedMetricValue value={financeData?.totalBalance} format="currency" /></p>
                </div>
              </div>

              <section className="finance-grid">
                <article className="card glass finance-form-card">
                  <div className="row-between finance-section-head">
                    <div>
                      <h3>Lançar gasto</h3>
                      <p className="hint">Registre saídas com título, valor, descrição e até 10 comprovantes permanentes.</p>
                    </div>
                  </div>
                  <form className="finance-form" onSubmit={createExpense}>
                    <input
                      placeholder="Título do gasto"
                      value={expenseForm.title}
                      onChange={(e) => setExpenseForm((prev) => ({ ...prev, title: e.target.value }))}
                      required
                    />
                    <div className="finance-form-row">
                      <input
                        type="date"
                        value={expenseForm.expenseDate}
                        onChange={(e) => setExpenseForm((prev) => ({ ...prev, expenseDate: e.target.value }))}
                        required
                      />
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        placeholder="Valor (R$)"
                        value={expenseForm.amount}
                        onChange={(e) => setExpenseForm((prev) => ({ ...prev, amount: e.target.value }))}
                        required
                      />
                    </div>
                    <textarea
                      placeholder="Descrição do gasto (opcional)"
                      rows={4}
                      maxLength={1500}
                      value={expenseForm.description}
                      onChange={(e) => setExpenseForm((prev) => ({ ...prev, description: e.target.value }))}
                    />
                    <input
                      key={expenseFileInputKey}
                      type="file"
                      accept="image/*,.pdf"
                      multiple
                      onChange={handleExpenseFilesChange}
                    />
                    {expenseFiles.length > 0 && (
                      <div className="selected-files">
                        {expenseFiles.map((file) => (
                          <span key={`${file.name}-${file.lastModified}`} className="file-chip">
                            {file.name}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="finance-form-footer">
                      <p className="hint">Até 10 comprovantes por gasto. Esses arquivos não expiram.</p>
                      <button type="submit" disabled={creatingExpense}>
                        {creatingExpense ? "Registrando gasto..." : "Registrar gasto"}
                      </button>
                    </div>
                  </form>
                </article>

                <article className="card chart glass card-overflow-visible finance-chart-card">
                  <div className="row-between chart-head finance-section-head">
                    <div>
                      <h3>{financePeriodLabel.chartTitle}</h3>
                      <p className="hint">{financePeriodLabel.chartSubtitle}</p>
                    </div>
                  </div>
                  {financeChartData.length === 0 ? (
                    <p className="empty-hint">Ainda não há entradas ou gastos registrados no período selecionado.</p>
                  ) : (
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={financeChartData}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="label" />
                        <YAxis />
                        <Tooltip formatter={(value) => money(value)} />
                        <Legend />
                        <Bar dataKey="receitas" name="Receitas" fill="#1a2f86" radius={[8, 8, 0, 0]} />
                        <Bar dataKey="gastos" name="Gastos" fill="#c93e8f" radius={[8, 8, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </article>
              </section>

              <article className="card glass card-overflow-visible finance-expenses-card">
                <div className="row-between finance-section-head">
                  <div>
                    <h3>Gastos lançados</h3>
                    <p className="hint">{financeData?.expenseCount || 0} gasto(s) no período {dashboardPeriodChip.toLowerCase()}.</p>
                  </div>
                </div>
                {visibleExpenses.length === 0 ? (
                  <p className="empty-hint">Nenhum gasto registrado neste período.</p>
                ) : (
                  <ul className="list finance-expense-list">
                    {visibleExpenses.map((expense) => (
                      <li key={expense.id}>
                        <div className="list-primary finance-expense-primary">
                          <div className="finance-expense-headline">
                            <strong className="finance-expense-title">{expense.title}</strong>
                            <span className="finance-amount-pill">{money(expense.amount)}</span>
                          </div>
                          <span className="list-text">
                            Gasto em {formatDatePt(expense.expense_date)} — lançado por {expense.created_by_name || "Admin"} em {formatDateTimePt(expense.created_at)}
                          </span>
                          {expense.description && <p className="finance-expense-description">{expense.description}</p>}
                        </div>
                        <div className="proof-actions finance-expense-actions">
                          <span className="security-badge">
                            {expense.attachment_count || 0} comprovante{expense.attachment_count === 1 ? "" : "s"}
                          </span>
                          <HoverMenu label="Comprovantes" align="end" className="hover-menu--overlay">
                            <div className="menu-list-inner menu-list-scroll">
                              {expense.attachments?.length ? (
                                expense.attachments.map((attachment, index) => (
                                  <button type="button" key={attachment.id || `${expense.id}-${index}`} onClick={() => openProof(attachment.file_url)}>
                                    {attachment.original_name || `Comprovante ${index + 1}`}
                                  </button>
                                ))
                              ) : (
                                <button type="button" disabled>
                                  Sem comprovantes anexados
                                </button>
                              )}
                            </div>
                          </HoverMenu>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {financeExpenses.length > 4 && (
                  <button type="button" onClick={() => setShowAllExpenses((prev) => !prev)}>
                    {showAllExpenses ? "Ver menos" : "Ver mais"}
                  </button>
                )}
              </article>
              </MotionDiv>
            )}
          </AnimatePresence>

          {adminSection === "dashboard" && (
            <MotionDiv className="card glass security-card" {...buildRevealMotion(0.12, 18)}>
              <div className="row-between">
                <div>
                  <h3>Segurança e administradores</h3>
                  <p className="hint">Troque sua senha, crie novos admins e acompanhe quem já possui acesso total.</p>
                </div>
              </div>
              <div className="security-grid">
                <section className="security-panel">
                  <div className="security-panel-header">
                    <h4>Trocar minha senha</h4>
                    <p className="hint">Use pelo menos 8 caracteres com letras e números.</p>
                  </div>
                  <form className="security-form" onSubmit={changeOwnPassword}>
                    <input
                      type="password"
                      placeholder="Senha atual"
                      autoComplete="current-password"
                      value={passwordForm.currentPassword}
                      onChange={(e) => setPasswordForm((prev) => ({ ...prev, currentPassword: e.target.value }))}
                      required
                    />
                    <input
                      type="password"
                      placeholder="Nova senha"
                      autoComplete="new-password"
                      value={passwordForm.newPassword}
                      onChange={(e) => setPasswordForm((prev) => ({ ...prev, newPassword: e.target.value }))}
                      required
                    />
                    <input
                      type="password"
                      placeholder="Confirmar nova senha"
                      autoComplete="new-password"
                      value={passwordForm.confirmPassword}
                      onChange={(e) => setPasswordForm((prev) => ({ ...prev, confirmPassword: e.target.value }))}
                      required
                    />
                    <button type="submit" disabled={changingPassword}>
                      {changingPassword ? "Atualizando senha..." : "Atualizar minha senha"}
                    </button>
                  </form>
                </section>

                <section className="security-panel">
                  <div className="security-panel-header">
                    <h4>Novo administrador</h4>
                    <p className="hint">Cadastre um segundo admin para evitar depender de uma única conta.</p>
                  </div>
                  <form className="security-form" onSubmit={createAdminAccount}>
                    <input
                      placeholder="Nome completo"
                      value={adminCreateForm.name}
                      onChange={(e) => setAdminCreateForm((prev) => ({ ...prev, name: e.target.value }))}
                      required
                    />
                    <input
                      type="email"
                      placeholder="E-mail"
                      value={adminCreateForm.email}
                      onChange={(e) => setAdminCreateForm((prev) => ({ ...prev, email: e.target.value }))}
                      required
                    />
                    <input
                      placeholder="Telefone (opcional)"
                      type="tel"
                      inputMode="numeric"
                      autoComplete="tel"
                      maxLength={MAX_PHONE_MASK_LENGTH}
                      value={adminCreateForm.phone}
                      onChange={(e) => setAdminCreateForm((prev) => ({ ...prev, phone: formatPhoneInput(e.target.value) }))}
                    />
                    <input
                      type="password"
                      placeholder="Senha inicial"
                      autoComplete="new-password"
                      value={adminCreateForm.password}
                      onChange={(e) => setAdminCreateForm((prev) => ({ ...prev, password: e.target.value }))}
                      required
                    />
                    <button type="submit" disabled={creatingAdmin}>
                      {creatingAdmin ? "Criando administrador..." : "Criar administrador"}
                    </button>
                  </form>
                </section>
              </div>

              <section className="security-panel security-admin-list-panel">
                <div className="security-panel-header">
                  <h4>Administradores cadastrados</h4>
                  <p className="hint">Cada admin pode trocar a própria senha nesta mesma área.</p>
                </div>
                {adminAccounts.length === 0 ? (
                  <p className="empty-hint">Nenhum administrador encontrado.</p>
                ) : (
                  <ul className="list security-admin-list">
                    {adminAccounts.map((adminAccount) => (
                      <li key={adminAccount.id}>
                        <div className="list-primary security-admin-primary">
                          <strong className="security-admin-name">{adminAccount.name || "Administrador"}</strong>
                          <span className="list-text">
                            {adminAccount.email}
                            {adminAccount.phone ? ` — ${adminAccount.phone}` : ""}
                          </span>
                          <span className="feedback-meta">Criado em {formatDatePt(adminAccount.created_at)}</span>
                        </div>
                        <div className="security-admin-meta">
                          {adminAccount.id === user?.id && <span className="security-badge">Você</span>}
                          <span className="security-badge">Admin</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </MotionDiv>
          )}
        </section>
      )}

      <AnimatePresence>
        {message && (
          <MotionDiv
            className="toast"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
          >
            {message}
          </MotionDiv>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {paymentCelebration && (
          <MotionDiv
            className="payment-celebration"
            initial={{ opacity: 0, scale: 0.92, y: 18 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: 18 }}
          >
            <div className="payment-celebration-burst" aria-hidden="true">
              {["🎉", "✨", "💙", "🏋️", "💸"].map((emoji, index) => (
                <MotionSpan
                  key={`${emoji}-${index}`}
                  className="payment-celebration-emoji"
                  initial={{ opacity: 0, y: 16, scale: 0.7, rotate: -10 }}
                  animate={{ opacity: [0, 1, 0.92], y: [16, -14, -26], scale: [0.7, 1.08, 1], rotate: [-10, 8, 0] }}
                  exit={{ opacity: 0, y: -32, scale: 0.6 }}
                  transition={{ duration: 1.5, delay: index * 0.06 }}
                >
                  {emoji}
                </MotionSpan>
              ))}
            </div>
            <strong>{paymentCelebration.title}</strong>
            <p>{paymentCelebration.subtitle}</p>
          </MotionDiv>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {previewImage && (
          <MotionDiv className="modal-bg" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <MotionDiv
              className="modal-box"
              initial={{ y: 30, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 30, opacity: 0 }}
            >
              <button type="button" onClick={() => setPreviewImage("")}>
                Fechar
              </button>
              <img src={previewImage} alt="Comprovante anexado" />
            </MotionDiv>
          </MotionDiv>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {selectedPaymentId && (
          <MotionDiv className="modal-bg" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <MotionDiv
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
            </MotionDiv>
          </MotionDiv>
        )}
      </AnimatePresence>
    </div>
  );
}

export default App;

// API client for nexus-backend
import { DEMO_USERS, demoData } from "./demoData";

const BASE = (import.meta.env.VITE_API_URL as string) || "https://api.nexus-x.site/api";
const TOKEN_KEY = "nexus_token";
const DEMO_KEY = "nexus_demo_mode";

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export const demoMode = {
  enabled: () => localStorage.getItem(DEMO_KEY) === "true",
  enable: () => localStorage.setItem(DEMO_KEY, "true"),
  disable: () => localStorage.removeItem(DEMO_KEY),
};

// In-memory IMS bot state for demo mode (preview without backend)
const demoImsState = (() => {
  let running = true;
  let loggedIn = true;
  let totalScrapes = 47;
  let numbersAdded = 128;
  let otpsDelivered = 312;
  const events: { ts: number; level: string; message: string; meta: unknown }[] = [
    { ts: Math.floor(Date.now() / 1000) - 8, level: "success", message: "OTP delivered to +8801712345678", meta: { otp: "458291" } },
    { ts: Math.floor(Date.now() / 1000) - 24, level: "success", message: "Pool +3 new numbers", meta: { scraped: 12 } },
    { ts: Math.floor(Date.now() / 1000) - 56, level: "info", message: "Scrape cycle completed", meta: null },
    { ts: Math.floor(Date.now() / 1000) - 120, level: "success", message: "Logged in to imssms.org", meta: null },
    { ts: Math.floor(Date.now() / 1000) - 180, level: "info", message: "Bot started", meta: null },
  ];
  const startTs = Math.floor(Date.now() / 1000) - 180;
  return {
    snapshot() {
      return {
        enabled: true,
        running,
        loggedIn: running && loggedIn,
        lastLoginAt: running ? startTs : null,
        lastScrapeAt: running ? Math.floor(Date.now() / 1000) - 6 : null,
        lastScrapeOk: running,
        lastError: null as string | null,
        lastErrorAt: null as number | null,
        totalScrapes,
        numbersScrapedTotal: numbersAdded * 3,
        numbersAddedTotal: numbersAdded,
        otpsDeliveredTotal: otpsDelivered,
        consecFail: 0,
        baseUrl: "https://www.imssms.org",
        intervalSec: 8,
        poolSize: 47,
        activeAssigned: 12,
        otpReceived: otpsDelivered,
        emptyStreak: running ? 2 : 0,
        emptyLimit: 10,
        events: events.slice(0, 20),
      };
    },
    start() {
      if (running) return;
      running = true;
      loggedIn = true;
      events.unshift({ ts: Math.floor(Date.now() / 1000), level: "success", message: "Bot started by admin", meta: null });
    },
    stop() {
      if (!running) return;
      running = false;
      loggedIn = false;
      events.unshift({ ts: Math.floor(Date.now() / 1000), level: "warn", message: "Bot stopped by admin", meta: null });
    },
    restart() {
      events.unshift({ ts: Math.floor(Date.now() / 1000), level: "info", message: "Bot restart requested by admin", meta: null });
      setTimeout(() => {
        running = true; loggedIn = true; totalScrapes++;
        events.unshift({ ts: Math.floor(Date.now() / 1000), level: "success", message: "Bot restarted successfully", meta: null });
      }, 800);
    },
  };
})();

async function request<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = tokenStore.get();
  // If demo mode is on OR the token looks like a demo token, short-circuit to demo handler
  if (demoMode.enabled() || (token && token.startsWith("demo_"))) {
    const demo = demoRoute(path, opts);
    if (demo !== undefined) return demo as T;
  }
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opts.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as any).error || `Request failed: ${res.status}`);
    return data as T;
  } catch (err: any) {
    // Network failure → try demo fallback automatically
    if (/Failed to fetch|NetworkError|TypeError/.test(err?.message || "")) {
      const demo = demoRoute(path, opts);
      if (demo !== undefined) {
        demoMode.enable();
        return demo as T;
      }
    }
    throw err;
  }
}

/** Map an API path to a demo response. Returns undefined if no demo handler. */
function demoRoute(path: string, opts: RequestInit): any {
  const method = (opts.method || "GET").toUpperCase();
  const body = opts.body ? JSON.parse(opts.body as string) : {};

  if (path === "/auth/login" && method === "POST") {
    const { username, password } = body;
    const u = (DEMO_USERS as any)[username];
    if (!u || u.password !== password) throw new Error("Invalid credentials (demo mode)");
    return { token: `demo_${username}_${Date.now()}`, user: u.user };
  }
  if (path === "/auth/me") {
    const t = tokenStore.get() || "";
    const m = t.match(/^demo_(\w+)_/);
    if (m) {
      const u = (DEMO_USERS as any)[m[1]];
      if (u) return { user: u.user };
    }
    return undefined;
  }

  if (path === "/admin/stats") return demoData.adminStats();
  if (path === "/admin/leaderboard") return demoData.leaderboard();
  if (path === "/admin/allocations") return demoData.allocations();
  if (path === "/admin/agents") return demoData.agents();
  if (path === "/admin/ims-status") return { status: demoImsState.snapshot() };
  if (path === "/admin/ims-restart" && method === "POST") { demoImsState.restart(); return { ok: true }; }
  if (path === "/admin/ims-start" && method === "POST") { demoImsState.start(); return { ok: true }; }
  if (path === "/admin/ims-stop" && method === "POST") { demoImsState.stop(); return { ok: true }; }
  if (path === "/admin/provider-status") return {
    providers: [
      { id: "acchub", name: "AccHub", configured: true, baseUrl: "https://sms.acchub.io", username: "Sh****YE", loggedIn: true, balance: 24.85, currency: "USD", lastError: null, otpHistoryCount: 12 },
      { id: "ims", name: "IMS SMS", configured: true, baseUrl: "https://www.imssms.org", username: "Sh****n7", loggedIn: true, balance: null, currency: "USD", lastError: null, otpHistoryCount: 0 },
    ],
  };

  if (path === "/rates") return demoData.rates();
  if (path === "/cdr" || path === "/cdr/mine") return demoData.cdr();
  if (path === "/payments" || path === "/payments/mine") return demoData.payments();
  if (path === "/withdrawals" || path === "/withdrawals/pending" || path === "/withdrawals/mine") return demoData.withdrawals();

  if (path === "/numbers/providers") return demoData.providers();
  if (path === "/numbers/pricing") return demoData.pricing();
  if (path.startsWith("/numbers/countries/")) return demoData.countries();
  if (path.startsWith("/numbers/operators/")) {
    const parts = path.split("/");
    const cid = Number(parts[parts.length - 1]);
    return demoData.operators(Number.isFinite(cid) ? cid : undefined);
  }
  if (path === "/numbers/get" && method === "POST") {
    const b = (body || {}) as { country_id?: number; operator_id?: number; count?: number };
    const count = Math.max(1, Math.min(b.count || 1, 15));
    const allocated: any[] = [];
    for (let i = 0; i < count; i++) allocated.push(...demoData.getNumber(b.country_id, b.operator_id).allocated);
    return { allocated, errors: [] as string[] };
  }
  if (path === "/numbers/my") return demoData.myNumbers();
  if (path === "/numbers/summary") return demoData.numberSummary();
  if (path === "/otp/sync" && method === "POST") return demoData.syncOtp();

  if (path === "/notifications") return demoData.notifications();
  if (path.startsWith("/audit")) return demoData.audit();
  if (path === "/sessions/mine" || path === "/sessions") return demoData.sessions();

  if (path === "/settings/public") return demoData.settings();
  if (path === "/settings") return demoData.settingsAll();

  if (method !== "GET") return { ok: true, id: Date.now() };
  return undefined;
}

export type Agent = {
  id: number; username: string; role: string; balance: number; otp_count: number;
  daily_limit: number; per_request_limit: number; status: string;
  telegram?: string; phone?: string; full_name?: string; created_at: number;
};
export type Allocation = {
  id: number; user_id: number; username?: string; provider: string;
  country_code?: string; operator?: string; phone_number: string;
  otp?: string | null; status: string; allocated_at: number; otp_received_at?: number;
};
export type Rate = {
  id: number; provider: string; country_code?: string; country_name?: string;
  operator?: string; price_bdt: number; agent_commission_percent?: number;
  active: number; updated_at: number;
};
export type CDR = {
  id: number; user_id: number; username?: string; provider: string;
  country_code?: string; operator?: string; phone_number: string; otp_code?: string;
  price_bdt: number; status: string; note?: string; created_at: number;
};
export type Payment = {
  id: number; user_id: number; username?: string; amount_bdt: number;
  type: string; method?: string; reference?: string; note?: string; created_at: number;
};
export type Withdrawal = {
  id: number; user_id: number; username?: string; amount_bdt: number;
  method: string; account_name?: string; account_number: string;
  status: "pending" | "approved" | "rejected"; note?: string;
  admin_note?: string; reviewed_by?: number; reviewed_at?: number;
  created_at: number;
};
export type Notification = {
  id: number; user_id: number | null; title: string; message: string;
  type: string; is_read: number; created_at: number;
};
export type AuditLog = {
  id: number; user_id: number | null; username?: string; action: string;
  target_type?: string; target_id?: string | number; meta?: string;
  ip?: string; user_agent?: string; created_at: number;
};
export type Session = {
  id: number; user_id: number; username?: string; ip: string;
  user_agent: string; device?: string; browser?: string;
  created_at: number; last_seen_at: number; current?: boolean;
};

export const api = {
  // Auth
  login: (username: string, password: string) =>
    request<{ token: string; user: any }>("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  me: () => request<{ user: any }>("/auth/me"),

  // Numbers
  providers: () => request<{ providers: { id: string; name: string }[] }>("/numbers/providers"),
  countries: (provider: string) => request<{ countries: any[] }>(`/numbers/countries/${provider}`),
  operators: (provider: string, countryId: number) =>
    request<{ operators: any[] }>(`/numbers/operators/${provider}/${countryId}`),
  getNumber: (body: { provider: string; country_id?: number; operator_id?: number; count?: number }) =>
    request<{ allocated: any[]; errors: string[] }>("/numbers/get", { method: "POST", body: JSON.stringify(body) }),
  myNumbers: () => request<{ numbers: Allocation[] }>("/numbers/my"),
  releaseNumber: (id: number) => request(`/numbers/release/${id}`, { method: "POST" }),
  numberSummary: () => request<{ today: { c: number; s: number }; week: { c: number; s: number }; month: { c: number; s: number }; active: number }>("/numbers/summary"),
  syncOtp: () => request<{ updated: number }>("/otp/sync", { method: "POST" }),
  pricing: () => request<{ pricing: { id: number; name: string; code: string; flag: string; price_bdt: number; operator_count: number }[] }>("/numbers/pricing"),

  // Rates
  rates: {
    list: () => request<{ rates: Rate[] }>("/rates"),
    create: (body: Partial<Rate>) => request<{ id: number }>("/rates", { method: "POST", body: JSON.stringify(body) }),
    update: (id: number, body: Partial<Rate>) => request(`/rates/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    remove: (id: number) => request(`/rates/${id}`, { method: "DELETE" }),
  },

  // CDR
  cdr: {
    mine: () => request<{ cdr: CDR[] }>("/cdr/mine"),
    all: () => request<{ cdr: CDR[] }>("/cdr"),
    refund: (id: number, note?: string) => request(`/cdr/${id}/refund`, { method: "POST", body: JSON.stringify({ note }) }),
  },

  // Payments
  payments: {
    mine: () => request<{ payments: Payment[] }>("/payments/mine"),
    all: () => request<{ payments: Payment[] }>("/payments"),
    topup: (body: { user_id: number; amount_bdt: number; method?: string; reference?: string; note?: string }) =>
      request("/payments/topup", { method: "POST", body: JSON.stringify(body) }),
  },

  // Withdrawals (Phase 3 — Revenue auto-engine)
  withdrawals: {
    mine: () => request<{ withdrawals: Withdrawal[] }>("/withdrawals/mine"),
    pending: () => request<{ withdrawals: Withdrawal[] }>("/withdrawals/pending"),
    all: () => request<{ withdrawals: Withdrawal[] }>("/withdrawals"),
    request: (body: { amount_bdt: number; method: string; account_name?: string; account_number: string; note?: string }) =>
      request<{ id: number }>("/withdrawals/request", { method: "POST", body: JSON.stringify(body) }),
    approve: (id: number, admin_note?: string) =>
      request(`/withdrawals/${id}/approve`, { method: "POST", body: JSON.stringify({ admin_note }) }),
    reject: (id: number, admin_note?: string) =>
      request(`/withdrawals/${id}/reject`, { method: "POST", body: JSON.stringify({ admin_note }) }),
  },

  // Notifications
  notifications: {
    list: () => request<{ notifications: Notification[]; unread: number }>("/notifications"),
    markRead: (id: number) => request(`/notifications/${id}/read`, { method: "POST" }),
    markAllRead: () => request("/notifications/read-all", { method: "POST" }),
    broadcast: (body: { title: string; message: string; type?: string; user_id?: number | null }) =>
      request("/notifications/broadcast", { method: "POST", body: JSON.stringify(body) }),
  },

  // Audit Logs (Phase 4 — Enterprise security)
  audit: {
    list: (params?: { limit?: number; user_id?: number; action?: string }) => {
      const q = new URLSearchParams();
      if (params?.limit) q.set("limit", String(params.limit));
      if (params?.user_id) q.set("user_id", String(params.user_id));
      if (params?.action) q.set("action", params.action);
      const qs = q.toString();
      return request<{ logs: AuditLog[] }>(`/audit${qs ? "?" + qs : ""}`);
    },
  },

  // Sessions (Phase 4 — active devices, remote logout)
  sessions: {
    mine: () => request<{ sessions: Session[] }>("/sessions/mine"),
    all: () => request<{ sessions: Session[] }>("/sessions"),
    revoke: (id: number) => request(`/sessions/${id}`, { method: "DELETE" }),
    revokeAllOthers: () => request(`/sessions/others`, { method: "DELETE" }),
  },
  settings: {
    getPublic: () => request<{ signup_enabled: boolean }>("/settings/public"),
    getAll: () => request<{ settings: Record<string, string> }>("/settings"),
    set: (key: string, value: string) => request(`/settings/${key}`, { method: "PUT", body: JSON.stringify({ value }) }),
  },

  // Admin
  admin: {
    agents: () => request<{ agents: Agent[] }>("/admin/agents"),
    createAgent: (body: any) => request<{ id: number }>("/admin/agents", { method: "POST", body: JSON.stringify(body) }),
    updateAgent: (id: number, body: any) => request(`/admin/agents/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    deleteAgent: (id: number) => request(`/admin/agents/${id}`, { method: "DELETE" }),
    stats: () => request<{
      totalAgents: number; activeAgents: number; totalAlloc: number; activeAlloc: number;
      totalOtp: number; todayOtp: number; todayRevenue: number; totalRevenue: number;
      todayCommission?: number; totalCommission?: number; pendingWithdrawals?: number;
    }>("/admin/stats"),
    leaderboard: () => request<{ leaderboard: { id: number; username: string; otp_count: number }[] }>("/admin/leaderboard"),
    allocations: () => request<{ allocations: Allocation[] }>("/admin/allocations"),
    imsStatus: () => request<{ status: any }>("/admin/ims-status"),
    imsRestart: () => request<{ ok: boolean }>("/admin/ims-restart", { method: "POST" }),
    imsStart: () => request<{ ok: boolean }>("/admin/ims-start", { method: "POST" }),
    imsStop: () => request<{ ok: boolean }>("/admin/ims-stop", { method: "POST" }),
    providerStatus: () => request<{ providers: ProviderStatus[] }>("/admin/provider-status"),
  },
};

export interface ProviderStatus {
  id: string;
  name: string;
  configured: boolean;
  baseUrl?: string;
  username?: string | null;
  loggedIn?: boolean;
  balance?: number | null;
  currency?: string;
  lastError?: string | null;
  otpHistoryCount?: number;
}

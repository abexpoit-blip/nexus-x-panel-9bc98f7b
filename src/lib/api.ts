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

// Typed API error — carries HTTP status + machine-readable `code` from the
// backend (e.g. 'PROVIDER_DISABLED') so callers can switch on intent
// instead of regex-matching the human-readable message.
export class ApiError extends Error {
  status: number;
  code?: string;
  data: unknown;
  constructor(message: string, status: number, data: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
    const c = (data as { code?: unknown })?.code;
    if (typeof c === "string") this.code = c;
  }
}

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
  let token = tokenStore.get();

  // Auto-clean stale demo tokens (legacy from preview/dev). Demo mode is fully off in production.
  if (token && token.startsWith("demo_")) {
    tokenStore.clear();
    localStorage.removeItem("nexus_demo_mode");
    token = null;
  }

  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    credentials: "include",                    // ← send/receive httpOnly cookie
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as { error?: string }).error || `Request failed: ${res.status}`;
    throw new ApiError(msg, res.status, data);
  }
  return data as T;
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
  if (path.startsWith("/admin/commission-trend")) return demoData.commissionTrend(14);
  if (path === "/admin/allocations") return demoData.allocations();
  if (path === "/admin/agents") return demoData.agents();
  if (path === "/admin/ims-status") return { status: demoImsState.snapshot() };
  if (path === "/admin/impersonations") return { impersonations: [
    { id: 1, created_at: Math.floor(Date.now()/1000) - 1800, action: "impersonation_start", admin_id: 1, agent_id: 2, admin_username: "admin", agent_username: "demo_agent", ip: "127.0.0.1", meta: '{"username":"demo_agent"}' },
    { id: 2, created_at: Math.floor(Date.now()/1000) - 1500, action: "impersonation_end", admin_id: 1, agent_id: 2, admin_username: "admin", agent_username: "demo_agent", ip: "127.0.0.1" },
  ] };
  if (path === "/admin/ims-restart" && method === "POST") { demoImsState.restart(); return { ok: true }; }
  if (path === "/admin/ims-start" && method === "POST") { demoImsState.start(); return { ok: true }; }
  if (path === "/admin/ims-stop" && method === "POST") { demoImsState.stop(); return { ok: true }; }
  if (path === "/admin/ims-scrape-numbers" && method === "POST") return { ok: true, jobId: Date.now(), status: "running" };
  if (path === "/admin/ims-numbers-job") return { id: 0, status: "idle", startedAt: null, finishedAt: null, result: null, error: null, progress: "" };
  if (path === "/admin/ims-credentials" && method === "GET") return {
    enabled: true, base_url: "https://www.imssms.org", username: "Shovonkhan7",
    password_masked: "Sh****34", has_password: true,
    source: { username: "database", password: "database" },
  };
  if (path === "/admin/ims-credentials" && method === "PUT") { demoImsState.restart(); return { ok: true }; }
  if (path === "/admin/ims-cookies" && method === "GET") return { has_cookies: false, count: 0, saved_at: null };
  if (path === "/admin/ims-cookies" && method === "PUT") { demoImsState.restart(); return { ok: true }; }
  if (path === "/admin/ims-cookies" && method === "DELETE") { demoImsState.restart(); return { ok: true }; }
  if (path === "/admin/ims-otp-interval" && method === "GET") return {
    interval_sec: 10, source: "env", options: [5, 10, 30], min: 3, max: 120,
  };
  if (path === "/admin/ims-otp-interval" && method === "PUT") { demoImsState.restart(); return { ok: true, interval_sec: 10 }; }
  if (path === "/admin/msi-cookies" && method === "GET") return { has_cookies: false, count: 0, saved_at: null };
  if (path === "/admin/msi-cookies" && method === "PUT") return { ok: true };
  if (path === "/admin/msi-cookies" && method === "DELETE") return { ok: true };
  if (path === "/admin/provider-status") return {
    providers: [
      { id: "acchub", name: "AccHub", configured: true, baseUrl: "https://sms.acchub.io", username: "Sh****YE", loggedIn: true, balance: 24.85, currency: "USD", lastError: null, otpHistoryCount: 12 },
      { id: "ims", name: "IMS SMS", configured: true, baseUrl: "https://www.imssms.org", username: "Sh****n7", loggedIn: true, balance: null, currency: "USD", lastError: null, otpHistoryCount: 0 },
    ],
  };
  if (path === "/admin/system-health") {
    const now = Math.floor(Date.now() / 1000);
    return {
      server: {
        uptime_sec: 86400 + 3600 * 7,
        node_version: "v20.11.1",
        env: "production",
        memory_mb: { rss: 142.3, heap_used: 68.7, heap_total: 95.4 },
      },
      database: {
        size_bytes: 4_823_552,
        size_mb: 4.6,
        path: "./data/nexus.db",
        last_backup: { name: "nexus-2025-04-17-0400.db.gz", size: 1_234_000, mtime: now - 3600 * 9 },
        backup_dir: "/opt/nexus/backups",
      },
      ims_bot: {
        enabled: true, running: true, logged_in: true,
        pool_size: 4823, active_assigned: 12,
        last_scrape_at: now - 22, last_scrape_ok: true,
        interval_sec: 60, otp_interval_sec: 10, consec_fail: 0, last_error: null,
      },
      acchub_poller: { running: true, lastTickAt: now - 4 },
      counts: { pending_withdrawals: 2, active_sessions: 5, ims_pool_size: 4823 },
    };
  }

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
  if (path === "/numbers/sync" && method === "POST") return demoData.syncOtp();

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
  cli?: string | null;
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
  processed_at?: number;
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
  login: (username: string, password: string, surface: "agent" | "admin" = "agent") =>
    request<{ token: string; user: any }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
      headers: { "X-Login-Surface": surface },
    }),
  register: (body: { username: string; password: string; full_name?: string; phone?: string; telegram?: string }) =>
    request<{ pending?: boolean; message?: string; token?: string; user?: any }>("/auth/register", { method: "POST", body: JSON.stringify(body) }),
  me: () => request<{ user: any; impersonator?: { id: number; username: string } | null }>("/auth/me"),
  logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  exitImpersonation: () =>
    request<{ token: string; user: any }>("/auth/exit-impersonation", { method: "POST" }),
  changePassword: (current_password: string, new_password: string) =>
    request<{ ok: boolean; message: string }>("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password, new_password }),
    }),

  // Numbers
  providers: () => request<{ providers: { id: string; name: string }[] }>("/numbers/providers"),
  numbersConfig: () => request<{ otp_expiry_sec: number; server_now: number }>("/numbers/config"),
  countries: (provider: string) => request<{ countries: any[] }>(`/numbers/countries/${provider}`),
  operators: (provider: string, countryId: number) =>
    request<{ operators: any[] }>(`/numbers/operators/${provider}/${countryId}`),
  getNumber: (body: { provider: string; country_id?: number; operator_id?: number; range?: string; count?: number }) =>
    request<{ allocated: any[]; errors: string[] }>("/numbers/get", { method: "POST", body: JSON.stringify(body) }),
  imsRanges: () => request<{ ranges: { name: string; count: number }[] }>("/numbers/ims/ranges"),
  msiRanges: () => request<{ ranges: { name: string; count: number }[] }>("/numbers/msi/ranges"),
  // Unified pool across every enabled bot (ims/msi/iprn/iprn_sms/numpanel).
  // Each entry's `key` is "<providerId>::<rangeName>" and is what the agent
  // passes back as `range` when calling getNumber({ provider: 'all', range: key }).
  allRanges: () => request<{ ranges: {
    key: string; name: string; range: string; provider: string;
    provider_label: string; country_code: string | null;
    country_name?: string | null; count: number; hot?: boolean;
  }[] }>("/numbers/all/ranges"),
  imsAddPool: (body: { numbers: string[]; range: string; country_code?: string }) =>
    request<{ added: number; skipped: number; invalid: number; range: string }>("/numbers/ims/pool", { method: "POST", body: JSON.stringify(body) }),
  msiAddPool: (body: { numbers: string[]; range: string; country_code?: string }) =>
    request<{ added: number; skipped: number; invalid: number; range: string }>("/numbers/msi/pool", { method: "POST", body: JSON.stringify(body) }),
  myNumbers: () => request<{ numbers: Allocation[]; recent_window_hours?: number; otp_expiry_sec?: number; server_now?: number }>("/numbers/my"),
  numberHistory: (params: { page?: number; page_size?: number; q?: string; from?: string; to?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.page) qs.set("page", String(params.page));
    if (params.page_size) qs.set("page_size", String(params.page_size));
    if (params.q) qs.set("q", params.q);
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<{
      rows: Array<{
        id: number; allocation_id: number | null; country_code: string | null;
        operator: string | null; phone_number: string; otp_code: string;
        cli: string | null;
        price_bdt: number; created_at: number;
      }>;
      page: number; page_size: number; total: number; total_pages: number;
      summary: { count: number; earnings_bdt: number };
    }>(`/numbers/history${suffix}`);
  },
  // CSV export — fetches with auth header, triggers browser download via Blob URL.
  // Returns the row count downloaded so the UI can toast it.
  numberHistoryCsv: async (params: { q?: string; from?: string; to?: string } = {}) => {
    const qs = new URLSearchParams({ format: "csv" });
    if (params.q) qs.set("q", params.q);
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    const token = tokenStore.get();
    const res = await fetch(`${BASE}/numbers/history?${qs.toString()}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`CSV export failed (${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `otp-history-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    // Each non-empty line is one Number|OTP record (no header row anymore)
    const text = await blob.text();
    const lines = text.split("\n").filter(Boolean).length;
    return { rows: Math.max(0, lines) };
  },
  releaseNumber: (id: number) => request(`/numbers/release/${id}`, { method: "POST" }),
  numberSummary: () => request<{
    today: { c: number; s: number };
    week: { c: number; s: number };
    month: { c: number; s: number };
    active: number;
    wait_time?: {
      today: WaitStat; week: WaitStat; month: WaitStat; all_time: WaitStat;
    };
  }>("/numbers/summary"),
  syncOtp: () => request<{ updated: number }>("/numbers/sync", { method: "POST" }),
  // OTP delivery audit log — agent sees their own scrape→match→credit
  // events; admin sees the global feed (incl. unmatched / failures).
  otpAudit: (params: { limit?: number; provider?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.provider) qs.set("provider", params.provider);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<{
      rows: Array<{
        id: number; ts: number; provider: string; event: string;
        user_id: number | null; allocation_id: number | null;
        phone_number: string | null; otp_code: string | null;
        rows_seen: number | null; matches_found: number | null;
        endpoint: string | null; currency: string | null; detail: string | null;
      }>;
      stats_24h: { scrapes: number; failures: number; matched: number; credited: number; unmatched: number };
    }>(`/numbers/otp-audit${suffix}`);
  },
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
    feed: () => request<{ feed: Array<{
      id: number; phone_masked: string; otp_length: number;
      operator: string | null; country_code: string | null;
      cli: string | null;
      provider: string | null; created_at: number;
    }> }>("/cdr/feed"),
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
    policy: () => request<{
      min_amount: number; fee_percent: number; sla_hours: number;
      methods?: Record<string, boolean>; methods_enabled?: string[];
    }>("/withdrawals/policy"),
    mine: () => request<{ withdrawals: Withdrawal[] }>("/withdrawals/mine"),
    pending: () => request<{ withdrawals: Withdrawal[] }>("/withdrawals/pending"),
    all: (status?: string) => request<{ withdrawals: Withdrawal[] }>(`/withdrawals${status ? `?status=${status}` : ""}`),
    request: (body: { amount_bdt: number; method: string; account_name?: string; account_number: string; note?: string }) =>
      request<{ id: number; fee: number; net: number }>("/withdrawals/request", { method: "POST", body: JSON.stringify(body) }),
    approve: (id: number, admin_note?: string) =>
      request(`/withdrawals/${id}/approve`, { method: "POST", body: JSON.stringify({ admin_note }) }),
    reject: (id: number, admin_note?: string) =>
      request(`/withdrawals/${id}/reject`, { method: "POST", body: JSON.stringify({ admin_note }) }),
    config: () => request<PaymentConfig>("/admin/payment-config"),
    saveConfig: (body: Partial<PaymentConfig>) =>
      request<PaymentConfig>("/admin/payment-config", { method: "PUT", body: JSON.stringify(body) }),
  },

  // Notifications
  notifications: {
    list: () => request<{ notifications: Notification[]; unread: number }>("/notifications"),
    markRead: (id: number) => request(`/notifications/${id}/read`, { method: "POST" }),
    markAllRead: () => request("/notifications/read-all", { method: "POST" }),
    broadcast: (body: { title: string; message: string; type?: string; user_id?: number | null }) =>
      request("/notifications/broadcast", { method: "POST", body: JSON.stringify(body) }),
  },

  // Public leaderboard (any authenticated user)
  leaderboard: (period: "today" | "7d" | "all" = "today") =>
    request<{
      leaderboard: { id: number; username: string; otp_count: number; numbers_used?: number; earnings_bdt?: number }[];
      period: string;
    }>(`/leaderboard?period=${period}`),

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
    approveAgent: (id: number) => request(`/admin/agents/${id}/approve`, { method: "POST" }),
    rejectAgent: (id: number) => request(`/admin/agents/${id}/reject`, { method: "POST" }),
    loginAs: (id: number) =>
      request<{ token: string; user: any; impersonator: { id: number; username: string } }>(
        `/admin/login-as/${id}`, { method: "POST" }
      ),
    impersonations: () => request<{
      impersonations: {
        id: number; created_at: number; action: string;
        admin_id: number | null; agent_id: number | null;
        admin_username?: string; agent_username?: string;
        ip?: string; meta?: string;
      }[];
    }>("/admin/impersonations"),
    stats: () => request<{
      totalAgents: number; activeAgents: number; totalAlloc: number; activeAlloc: number;
      totalOtp: number; todayOtp: number; todayRevenue: number; totalRevenue: number;
      todayCommission?: number; totalCommission?: number; pendingWithdrawals?: number;
    }>("/admin/stats"),
    leaderboard: () => request<{ leaderboard: { id: number; username: string; otp_count: number; numbers_used?: number; earnings_bdt?: number }[] }>("/admin/leaderboard"),
    commissionTrend: (days = 14) => request<{ series: { label: string; value: number; count: number }[] }>(`/admin/commission-trend?days=${days}`),
    allocations: () => request<{ allocations: Allocation[] }>("/admin/allocations"),
    poolInspector: () => request<{ countries: {
      country_code: string;
      country_name: string;
      inferred: boolean;
      total: number;
      ranges: {
        range: string;
        total: number;
        bots: { provider: string; label: string; count: number }[];
      }[];
    }[] }>("/admin/pool-inspector"),
    imsStatus: () => request<{ status: any }>("/admin/ims-status"),
    imsRestart: () => request<{ ok: boolean }>("/admin/ims-restart", { method: "POST" }),
    imsStart: () => request<{ ok: boolean }>("/admin/ims-start", { method: "POST" }),
    imsStop: () => request<{ ok: boolean }>("/admin/ims-stop", { method: "POST" }),
    imsScrapeNow: () => request<{ ok: boolean; added?: number; otps?: number; error?: string }>("/admin/ims-scrape-now", { method: "POST" }),
    imsSyncLive: () => request<{ ok: boolean; added?: number; removed?: number; kept?: number; scraped?: number; ranges?: string[]; error?: string }>("/admin/ims-sync-live", { method: "POST" }),
    imsScrapeNumbersStart: () => request<{ ok: boolean; jobId?: number; status?: string; error?: string }>("/admin/ims-scrape-numbers", { method: "POST" }),
    imsNumbersJob: () => request<{ id: number; status: 'idle'|'running'|'done'|'failed'; startedAt: number|null; finishedAt: number|null; result: { added: number; removed: number; kept: number; scraped: number; ranges: string[] } | null; error: string|null; progress: string }>("/admin/ims-numbers-job"),
    imsPoolBreakdown: () => request<{
      ranges: {
        name: string; count: number; last_added: number; first_added?: number;
        custom_name: string | null; tag_color: string | null; priority: number | null;
        request_override: number | null; notes: string | null;
        disabled: number | null; service_tag: string | null;
      }[];
      totalActive: number; totalUsed?: number;
    }>("/admin/ims-pool-breakdown"),
    imsRangeMetaSave: (body: {
      range_prefix: string; custom_name?: string | null; tag_color?: string | null;
      priority?: number | null; request_override?: number | null; notes?: string | null;
      disabled?: boolean; service_tag?: string | null;
    }) => request<{ ok: boolean }>("/admin/ims-range-meta", { method: "PUT", body: JSON.stringify(body) }),
    imsRangeMetaDelete: (prefix: string) =>
      request<{ ok: boolean }>(`/admin/ims-range-meta/${encodeURIComponent(prefix)}`, { method: "DELETE" }),
    imsPoolCleanup: (body: { mode: "expired" | "older_than" | "range" | "all_pool"; hours?: number; range?: string }) =>
      request<{ ok: boolean; removed: number; description: string }>("/admin/ims-pool-cleanup", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    imsCredentials: () => request<{
      enabled: boolean; base_url: string; username: string;
      password_masked: string; has_password: boolean;
      source: { username: string; password: string };
    }>("/admin/ims-credentials"),
    imsCredentialsSave: (body: { username?: string; password?: string; base_url?: string; enabled?: boolean }) =>
      request<{ ok: boolean }>("/admin/ims-credentials", { method: "PUT", body: JSON.stringify(body) }),
    imsCookiesStatus: () =>
      request<{ has_cookies: boolean; count: number; saved_at: number | null }>("/admin/ims-cookies"),
    imsCookiesSave: (cookies: string) =>
      request<{ ok: boolean }>("/admin/ims-cookies", { method: "PUT", body: JSON.stringify({ cookies }) }),
    imsCookiesClear: () =>
      request<{ ok: boolean }>("/admin/ims-cookies", { method: "DELETE" }),
    imsOtpInterval: () => request<{
      interval_sec: number; source: string; options: number[]; min: number; max: number;
    }>("/admin/ims-otp-interval"),
    imsOtpIntervalSave: (interval_sec: number) =>
      request<{ ok: boolean; interval_sec: number }>("/admin/ims-otp-interval", {
        method: "PUT", body: JSON.stringify({ interval_sec }),
      }),
    msiCredentials: () => request<{
      enabled: boolean; base_url: string; username: string;
      password_masked: string; has_password: boolean;
      source: { username: string; password: string };
    }>("/admin/msi-credentials"),
    msiCredentialsSave: (body: { username?: string; password?: string; base_url?: string; enabled?: boolean }) =>
      request<{ ok: boolean }>("/admin/msi-credentials", { method: "PUT", body: JSON.stringify(body) }),
    msiOtpInterval: () => request<{ interval_sec: number; source: string; options: number[]; min: number; max: number }>("/admin/msi-otp-interval"),
    msiOtpIntervalSave: (interval_sec: number) =>
      request<{ ok: boolean; interval_sec: number }>("/admin/msi-otp-interval", { method: "PUT", body: JSON.stringify({ interval_sec }) }),
    msiCookiesStatus: () =>
      request<{ has_cookies: boolean; count: number; saved_at: number | null }>("/admin/msi-cookies"),
    msiCookiesSave: (cookies: string) =>
      request<{ ok: boolean }>("/admin/msi-cookies", { method: "PUT", body: JSON.stringify({ cookies }) }),
    msiCookiesClear: () =>
      request<{ ok: boolean }>("/admin/msi-cookies", { method: "DELETE" }),

    // ---- MSI Bot status / control ----
    msiStatus: () => request<{ status: any }>("/admin/msi-status"),
    msiRestart: () => request<{ ok: boolean }>("/admin/msi-restart", { method: "POST" }),
    msiStart: () => request<{ ok: boolean }>("/admin/msi-start", { method: "POST" }),
    msiStop: () => request<{ ok: boolean }>("/admin/msi-stop", { method: "POST" }),
    msiScrapeNow: () => request<{ ok: boolean; added?: number; otps?: number; error?: string }>("/admin/msi-scrape-now", { method: "POST" }),
    msiSyncLive: () => request<{ ok: boolean; added?: number; removed?: number; kept?: number; scraped?: number; ranges?: string[]; error?: string }>("/admin/msi-sync-live", { method: "POST" }),
    msiPoolBreakdown: () => request<{
      ranges: {
        name: string; count: number; last_added: number; first_added?: number;
        custom_name: string | null; tag_color: string | null; priority: number | null;
        request_override: number | null; notes: string | null;
        disabled: number | null; service_tag: string | null;
      }[];
      totalActive: number; totalUsed?: number;
    }>("/admin/msi-pool-breakdown"),
    msiRangeMetaSave: (body: {
      range_prefix: string; custom_name?: string | null; tag_color?: string | null;
      priority?: number | null; request_override?: number | null; notes?: string | null;
      disabled?: boolean; service_tag?: string | null;
    }) => request<{ ok: boolean }>("/admin/msi-range-meta", { method: "PUT", body: JSON.stringify(body) }),
    msiRangeMetaDelete: (prefix: string) =>
      request<{ ok: boolean }>(`/admin/msi-range-meta/${encodeURIComponent(prefix)}`, { method: "DELETE" }),

    // ---- Global provider settings ----
    systemHealth: () => request<SystemHealth>("/admin/system-health"),
    providerStatus: () => request<{ providers: ProviderStatus[] }>("/admin/provider-status"),
    providerToggle: (id: string, enabled: boolean) =>
      request<{ ok: boolean; id: string; enabled: boolean; message: string }>("/admin/provider-toggle", {
        method: "PUT",
        body: JSON.stringify({ id, enabled }),
      }),
    otpExpiry: () => request<{ expiry_min: number; source: string; options_min: number[] }>("/admin/otp-expiry"),
    otpExpirySave: (expiry_min: number) =>
      request<{ ok: boolean; expiry_min: number }>("/admin/otp-expiry", {
        method: "PUT", body: JSON.stringify({ expiry_min }),
      }),
    recentOtpWindow: () => request<{ hours: number; source: string; options_hours: number[] }>("/admin/recent-otp-window"),
    recentOtpWindowSave: (hours: number) =>
      request<{ ok: boolean; hours: number }>("/admin/recent-otp-window", {
        method: "PUT", body: JSON.stringify({ hours }),
      }),

    // ---- AccHub credentials ----
    acchubCredentials: () => request<{
      enabled: boolean; base_url: string; username: string;
      password_masked: string; has_password: boolean;
      source: { username: string; password: string };
    }>("/admin/acchub-credentials"),
    acchubCredentialsSave: (body: { username?: string; password?: string; base_url?: string; enabled?: boolean }) =>
      request<{ ok: boolean }>("/admin/acchub-credentials", { method: "PUT", body: JSON.stringify(body) }),
    acchubTest: () => request<{
      ok: boolean;
      loggedIn?: boolean;
      error?: string;
      status?: { balance?: number | null; currency?: string | null; loggedIn?: boolean };
    }>("/admin/acchub-test", { method: "POST" }),

    // ---- NumPanel Bot ----
    numpanelStatus: () => request<{ status: any }>("/admin/numpanel-status"),
    numpanelRestart: () => request<{ ok: boolean }>("/admin/numpanel-restart", { method: "POST" }),
    numpanelStart: () => request<{ ok: boolean }>("/admin/numpanel-start", { method: "POST" }),
    numpanelStop: () => request<{ ok: boolean }>("/admin/numpanel-stop", { method: "POST" }),
    numpanelScrapeNow: () => request<{ ok: boolean; otps?: number; delivered?: number; error?: string }>("/admin/numpanel-scrape-now", { method: "POST" }),
    numpanelSyncLive: () => request<{ ok: boolean; added?: number; removed?: number; kept?: number; scraped?: number; error?: string }>("/admin/numpanel-sync-live", { method: "POST" }),
    numpanelPoolBreakdown: () => request<{
      ranges: {
        name: string; count: number; last_added: number; first_added: number;
        custom_name: string | null; tag_color: string | null; priority: number | null;
        request_override: number | null; notes: string | null;
        disabled: number | null; service_tag: string | null;
      }[];
      totalActive: number; totalUsed: number;
    }>("/admin/numpanel-pool-breakdown"),
    numpanelRangeMetaSave: (body: {
      range_prefix: string; custom_name?: string | null; tag_color?: string | null;
      priority?: number | null; request_override?: number | null; notes?: string | null;
      disabled?: boolean; service_tag?: string | null;
    }) => request<{ ok: boolean }>("/admin/numpanel-range-meta", { method: "PUT", body: JSON.stringify(body) }),
    numpanelRangeMetaDelete: (prefix: string) =>
      request<{ ok: boolean }>(`/admin/numpanel-range-meta/${encodeURIComponent(prefix)}`, { method: "DELETE" }),
    numpanelCredentials: () => request<{
      enabled: boolean; base_url: string; username: string;
      password_masked: string; has_password: boolean;
      source: { username: string; password: string };
    }>("/admin/numpanel-credentials"),
    numpanelCredentialsSave: (body: { username?: string; password?: string; base_url?: string; enabled?: boolean }) =>
      request<{ ok: boolean }>("/admin/numpanel-credentials", { method: "PUT", body: JSON.stringify(body) }),
    numpanelOtpInterval: () => request<{ interval_sec: number; source: string; options: number[]; min: number; max: number }>("/admin/numpanel-otp-interval"),
    numpanelOtpIntervalSave: (interval_sec: number) =>
      request<{ ok: boolean; interval_sec: number }>("/admin/numpanel-otp-interval", { method: "PUT", body: JSON.stringify({ interval_sec }) }),
    numpanelApiToken: () => request<{ has_token: boolean; token_masked: string; api_base: string; source: string }>("/admin/numpanel-api-token"),
    numpanelApiTokenSave: (body: { api_token?: string; api_base?: string }) =>
      request<{ ok: boolean }>("/admin/numpanel-api-token", { method: "PUT", body: JSON.stringify(body) }),
    numpanelCookiesStatus: () =>
      request<{ has_cookies: boolean; count: number; saved_at: number | null }>("/admin/numpanel-cookies"),
    numpanelCookiesSave: (cookies: string) =>
      request<{ ok: boolean }>("/admin/numpanel-cookies", { method: "PUT", body: JSON.stringify({ cookies }) }),
    numpanelCookiesClear: () =>
      request<{ ok: boolean }>("/admin/numpanel-cookies", { method: "DELETE" }),
  },

  // ===== IPRN Bot admin (HTTP-only, no cookies/captcha) =====
  iprn: {
    status: () => request<{ status: any }>("/admin/iprn-status"),
    restart: () => request<{ ok: boolean }>("/admin/iprn-restart", { method: "POST" }),
    start: () => request<{ ok: boolean }>("/admin/iprn-start", { method: "POST" }),
    stop: () => request<{ ok: boolean }>("/admin/iprn-stop", { method: "POST" }),
    scrapeNow: () => request<{ ok: boolean; added?: number; otps?: number; error?: string }>("/admin/iprn-scrape-now", { method: "POST" }),
    poolBreakdown: () => request<{
      ranges: Array<{
        name: string; count: number; last_added: number | null; first_added: number | null;
        custom_name: string | null; tag_color: string | null; priority: number | null;
        request_override: number | null; notes: string | null; disabled: number | null; service_tag: string | null;
      }>;
      totalActive: number; totalUsed: number;
    }>("/admin/iprn-pool-breakdown"),
    credentials: () => request<{
      enabled: boolean; base_url: string; username: string;
      password_masked: string; has_password: boolean;
      source: { username: string; password: string };
    }>("/admin/iprn-credentials"),
    credentialsSave: (body: { username?: string; password?: string; base_url?: string; enabled?: boolean }) =>
      request<{ ok: boolean }>("/admin/iprn-credentials", { method: "PUT", body: JSON.stringify(body) }),
    otpInterval: () => request<{ interval_sec: number; source: string; options: number[]; min: number; max: number }>("/admin/iprn-otp-interval"),
    otpIntervalSave: (interval_sec: number) =>
      request<{ ok: boolean; interval_sec: number }>("/admin/iprn-otp-interval", { method: "PUT", body: JSON.stringify({ interval_sec }) }),
    cookies: () =>
      request<{ has_cookies: boolean; count: number; saved_at: number | null; names?: string[] }>("/admin/iprn-cookies"),
    cookiesClear: () =>
      request<{ ok: boolean }>("/admin/iprn-cookies", { method: "DELETE" }),
    numbers: (params: { status?: string; q?: string; limit?: number; offset?: number } = {}) => {
      const qs = new URLSearchParams();
      if (params.status) qs.set("status", params.status);
      if (params.q) qs.set("q", params.q);
      if (params.limit != null) qs.set("limit", String(params.limit));
      if (params.offset != null) qs.set("offset", String(params.offset));
      const tail = qs.toString();
      return request<{
        rows: Array<{
          id: number; phone_number: string; range_name: string | null;
          country_code: string | null; status: string;
          allocated_at: number; user_id: number; otp: string | null;
          username: string | null;
        }>;
        total: number; limit: number; offset: number;
        counts: Record<string, number>;
      }>(`/admin/iprn-numbers${tail ? `?${tail}` : ""}`);
    },
  },

  // ===== IPRN-SMS Bot admin (panel.iprn-sms.com — Symfony, JSON API + ZIP) =====
  iprnSms: {
    status: () => request<{ status: any }>("/admin/iprn-sms-status"),
    restart: () => request<{ ok: boolean }>("/admin/iprn-sms-restart", { method: "POST" }),
    start: () => request<{ ok: boolean }>("/admin/iprn-sms-start", { method: "POST" }),
    stop: () => request<{ ok: boolean }>("/admin/iprn-sms-stop", { method: "POST" }),
    scrapeNow: () => request<{ ok: boolean; added?: number; error?: string }>("/admin/iprn-sms-scrape-now", { method: "POST" }),
    poolBreakdown: () => request<{
      ranges: Array<{ range_name: string; count: number; disabled: number }>;
      totalPool: number; totalActive: number; totalUsed: number;
    }>("/admin/iprn-sms-pool-breakdown"),
    credentials: () => request<{
      username: string; password_set: boolean; base_url: string;
      sms_type: string; enabled: boolean;
      sources: { username: string; password: string };
    }>("/admin/iprn-sms-credentials"),
    credentialsSave: (body: { username?: string; password?: string; base_url?: string; sms_type?: string; enabled?: boolean }) =>
      request<{ ok: boolean }>("/admin/iprn-sms-credentials", { method: "PUT", body: JSON.stringify(body) }),
    cookies: () =>
      request<{ has_cookies: boolean; count: number; saved_at: number | null; names?: string[] }>("/admin/iprn-sms-cookies"),
    cookiesClear: () =>
      request<{ ok: boolean }>("/admin/iprn-sms-cookies", { method: "DELETE" }),
    testLogin: () =>
      request<{ ok: boolean; username?: string; base_url?: string; loggedIn?: boolean; latency_ms: number; error?: string }>(
        "/admin/iprn-sms-test-login",
        { method: "POST" },
      ),
    numbers: (params: { status?: string; q?: string; limit?: number; offset?: number } = {}) => {
      const qs = new URLSearchParams();
      if (params.status) qs.set("status", params.status);
      if (params.q) qs.set("q", params.q);
      if (params.limit != null) qs.set("limit", String(params.limit));
      if (params.offset != null) qs.set("offset", String(params.offset));
      const tail = qs.toString();
      return request<{
        rows: Array<{
          id: number; phone_number: string; range_name: string | null;
          country_code: string | null; status: string;
          allocated_at: number; user_id: number; otp: string | null;
          username: string | null;
        }>;
        total: number; limit: number; offset: number;
        counts: Record<string, number>;
      }>(`/admin/iprn-sms-numbers${tail ? `?${tail}` : ""}`);
    },
  },

  // ===== Telegram Bot admin =====
  tgbot: {
    status: () => request<{
      totalUsers: number; activeUsers: number; onlineUsers: number;
      todayOtps: number; activeNumbers: number; totalDelivered: number;
      enabledRanges: number; totalRevenue: number;
    }>("/admin/tgbot/status"),
    users: (params: { page?: number; page_size?: number; q?: string } = {}) => {
      const qs = new URLSearchParams();
      if (params.page) qs.set("page", String(params.page));
      if (params.page_size) qs.set("page_size", String(params.page_size));
      if (params.q) qs.set("q", params.q);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return request<{
        rows: Array<{
          tg_user_id: number; username: string | null; first_name: string | null;
          balance_bdt: number; total_otps: number; total_spent: number;
          status: string; created_at: number; last_seen_at: number;
        }>;
        page: number; page_size: number; total: number; total_pages: number;
      }>(`/admin/tgbot/users${suffix}`);
    },
    topup: (id: number, amount: number, note?: string) =>
      request<{ ok: boolean }>(`/admin/tgbot/users/${id}/topup`, {
        method: "POST", body: JSON.stringify({ amount, note }),
      }),
    ban: (id: number, ban: boolean) =>
      request<{ ok: boolean }>(`/admin/tgbot/users/${id}/ban`, {
        method: "POST", body: JSON.stringify({ ban }),
      }),
    rangeSettings: () => request<{
      ranges: Array<{
        provider: string; range_name: string; country_code: string | null;
        pool_count: number; tg_enabled: boolean; tg_rate_bdt: number;
        service: string | null;
      }>;
    }>("/admin/tgbot/range-settings"),
    updateRange: (body: {
      provider: string; range_name: string; tg_enabled: boolean;
      tg_rate_bdt: number; service?: string;
    }) => request<{ ok: boolean }>("/admin/tgbot/range-settings", {
      method: "PUT", body: JSON.stringify(body),
    }),
    bulkRange: (body: {
      provider: string; country_code?: string; tg_enabled: boolean;
      tg_rate_bdt?: number; service?: string;
    }) => request<{ ok: boolean; updated: number }>("/admin/tgbot/range-settings/bulk", {
      method: "POST", body: JSON.stringify(body),
    }),
    otpFeed: (limit = 50) => request<{
      rows: Array<{
        id: number; tg_user_id: number; tg_username: string | null;
        phone_number: string; country_code: string | null; range_name: string;
        service: string | null; otp_code: string; otp_received_at: number;
        rate_bdt: number;
      }>;
    }>(`/admin/tgbot/otp-feed?limit=${limit}`),
    broadcast: (message: string) =>
      request<{ ok: boolean; id: number }>("/admin/tgbot/broadcast", {
        method: "POST", body: JSON.stringify({ message }),
      }),
    broadcasts: () => request<{
      broadcasts: Array<{
        id: number; message: string; status: string; sent_count: number;
        failed_count: number; created_at: number; finished_at: number | null;
        admin_username: string | null;
      }>;
    }>("/admin/tgbot/broadcasts"),
    config: () => request<{
      tg_public_channel: string;
      tg_required_group: string;
      tg_required_group_chat: string;
      tg_required_otp_group: string;
      tg_required_otp_group_chat: string;
      tg_terms_text: string;
    }>("/admin/tgbot/config"),
    saveConfig: (body: {
      tg_public_channel?: string;
      tg_required_group?: string;
      tg_required_group_chat?: string;
      tg_required_otp_group?: string;
      tg_required_otp_group_chat?: string;
      tg_terms_text?: string;
    }) => request<{ ok: boolean }>("/admin/tgbot/config", {
      method: "PUT", body: JSON.stringify(body),
    }),
  },

  // ===== Fake OTP Broadcaster (Security page) =====
  fakeOtp: {
    get: () => request<{
      enabled: boolean; min_sec: number; max_sec: number; burst: number;
    }>("/admin/fake-otp"),
    save: (body: { enabled?: boolean; min_sec?: number; max_sec?: number; burst?: number }) =>
      request<{ ok: boolean }>("/admin/fake-otp", {
        method: "PUT", body: JSON.stringify(body),
      }),
    purge: () => request<{ ok: boolean; removed: number }>("/admin/fake-otp/purge", { method: "POST" }),
  },
};

export interface PaymentConfig {
  min_amount: number;
  fee_percent: number;
  sla_hours: number;
  methods: Record<string, boolean>;
  methods_enabled: string[];
  all_methods: string[];
}

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
  enabled?: boolean;
  togglable?: boolean;
}

export interface WaitStat {
  avg_sec: number;
  min_sec: number;
  max_sec: number;
  samples: number;
}

export interface SystemHealth {
  server: {
    uptime_sec: number;
    node_version: string;
    env: string;
    memory_mb: { rss: number; heap_used: number; heap_total: number };
  };
  database: {
    size_bytes: number;
    size_mb: number;
    path: string;
    last_backup: { name: string; size: number; mtime: number } | null;
    backup_dir: string;
  };
  ims_bot: {
    enabled: boolean;
    running: boolean;
    logged_in?: boolean;
    pool_size: number;
    active_assigned?: number;
    last_scrape_at?: number | null;
    last_scrape_ok?: boolean;
    interval_sec?: number | null;
    otp_interval_sec?: number | null;
    consec_fail?: number;
    last_error?: string | null;
  };
  acchub_poller: { running?: boolean; lastTickAt?: number } | null;
  counts: {
    pending_withdrawals: number;
    active_sessions: number;
    ims_pool_size: number;
  };
}

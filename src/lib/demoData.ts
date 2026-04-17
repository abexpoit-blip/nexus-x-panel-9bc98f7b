// Mock data for demo mode (when backend is unreachable)
import type { Agent, Allocation, Rate, CDR, Payment, Withdrawal, Notification, AuditLog, Session } from "./api";

const now = Math.floor(Date.now() / 1000);
const day = 86400;

export const DEMO_USERS = {
  admin: {
    password: "admin123",
    user: { id: 1, username: "admin", role: "admin", balance: 0, otp_count: 0 },
  },
  demo_agent: {
    password: "demo123",
    user: { id: 2, username: "demo_agent", role: "agent", balance: 4250.75, otp_count: 387, daily_limit: 50, per_request_limit: 5, full_name: "Demo Agent", phone: "+8801712345678", telegram: "@demo_agent" },
  },
} as const;

const COUNTRIES = ["BD", "IN", "PK", "ID", "PH", "VN"];
const PROVIDERS = ["msi_sms", "ims_sms", "asshub", "seventtel"];
const AGENTS = ["rakib_x", "shanto", "tanvir", "ovi_pro", "rifat", "demo_agent", "milon", "arif_k"];

const rand = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

export const demoData = {
  adminStats: () => ({
    totalAgents: 24,
    activeAgents: 18,
    totalAlloc: 43000,
    activeAlloc: 1247,
    totalOtp: 38_456,
    todayOtp: 1316,
    todayRevenue: 18_420.5,
    totalRevenue: 547_890.25,
  }),
  leaderboard: () => ({
    leaderboard: AGENTS.slice(0, 8).map((u, i) => ({
      id: i + 2, username: u, otp_count: rand(120, 850),
    })).sort((a, b) => b.otp_count - a.otp_count),
  }),
  allocations: (): { allocations: Allocation[] } => ({
    allocations: Array.from({ length: 80 }, (_, i) => {
      const t = now - rand(0, 14 * day);
      const hasOtp = Math.random() > 0.35;
      return {
        id: i + 1, user_id: rand(2, 9), username: pick(AGENTS),
        provider: pick(PROVIDERS), country_code: pick(COUNTRIES),
        operator: pick(["Grameen", "Robi", "Banglalink", "Airtel"]),
        phone_number: `+88017${rand(10000000, 99999999)}`,
        otp: hasOtp ? `${rand(1000, 9999)}` : null,
        status: hasOtp ? "received" : "active",
        allocated_at: t,
        otp_received_at: hasOtp ? t + rand(20, 300) : undefined,
      };
    }),
  }),
  agents: (): { agents: Agent[] } => ({
    agents: AGENTS.map((u, i) => ({
      id: i + 2, username: u, role: "agent",
      balance: rand(500, 9000) + Math.random(), otp_count: rand(50, 850),
      daily_limit: 50, per_request_limit: 5, status: Math.random() > 0.2 ? "active" : "suspended",
      created_at: now - rand(30, 365) * day,
    })),
  }),
  rates: (): { rates: Rate[] } => ({
    rates: COUNTRIES.flatMap((cc) =>
      PROVIDERS.slice(0, 2).map((p, i) => ({
        id: COUNTRIES.indexOf(cc) * 10 + i,
        provider: p, country_code: cc, country_name: cc,
        operator: "Any", price_bdt: rand(8, 35) + Math.random(),
        active: 1, updated_at: now - rand(0, 30) * day,
      }))
    ),
  }),
  cdr: (): { cdr: CDR[] } => ({
    cdr: Array.from({ length: 60 }, (_, i) => ({
      id: i + 1, user_id: rand(2, 9), username: pick(AGENTS),
      provider: pick(PROVIDERS), country_code: pick(COUNTRIES),
      operator: pick(["Grameen", "Robi"]),
      phone_number: `+88017${rand(10000000, 99999999)}`,
      otp_code: `${rand(1000, 9999)}`, price_bdt: rand(8, 30),
      status: pick(["received", "refunded", "received"]),
      created_at: now - rand(0, 7 * day),
    })),
  }),
  payments: (): { payments: Payment[] } => ({
    payments: Array.from({ length: 40 }, (_, i) => ({
      id: i + 1, user_id: rand(2, 9), username: pick(AGENTS),
      amount_bdt: rand(100, 5000),
      type: pick(["topup", "credit", "debit"]),
      method: pick(["bkash", "nagad", "manual"]),
      reference: `TX${rand(100000, 999999)}`,
      created_at: now - rand(0, 30 * day),
    })),
  }),
  withdrawals: (): { withdrawals: Withdrawal[] } => ({
    withdrawals: Array.from({ length: 12 }, (_, i) => ({
      id: i + 1, user_id: rand(2, 9), username: pick(AGENTS),
      amount_bdt: rand(500, 5000), method: pick(["bkash", "nagad", "bank"]),
      account_name: "Demo User", account_number: `017${rand(10000000, 99999999)}`,
      status: pick(["pending", "approved", "rejected", "pending"]) as any,
      created_at: now - rand(0, 7 * day),
    })),
  }),
  notifications: (): { notifications: Notification[]; unread: number } => {
    const notifs = Array.from({ length: 8 }, (_, i) => ({
      id: i + 1, user_id: 1, title: pick(["New OTP", "Withdrawal Request", "Provider Alert", "System Update"]),
      message: "Demo notification message for premium UI preview.",
      type: pick(["info", "success", "warning"]),
      is_read: i > 2 ? 1 : 0,
      created_at: now - rand(0, 3 * day),
    }));
    return { notifications: notifs, unread: notifs.filter(n => !n.is_read).length };
  },
  audit: (): { logs: AuditLog[] } => ({
    logs: Array.from({ length: 30 }, (_, i) => ({
      id: i + 1, user_id: rand(1, 9), username: pick([...AGENTS, "admin"]),
      action: pick(["login", "topup", "withdrawal_request", "agent_created", "rate_updated", "allocation"]),
      ip: `103.${rand(0, 255)}.${rand(0, 255)}.${rand(0, 255)}`,
      user_agent: "Mozilla/5.0 (Windows NT 10.0)",
      created_at: now - rand(0, 7 * day),
    })),
  }),
  sessions: (): { sessions: Session[] } => ({
    sessions: Array.from({ length: 5 }, (_, i) => ({
      id: i + 1, user_id: 1, username: "admin",
      ip: `103.${rand(0, 255)}.${rand(0, 255)}.${rand(0, 255)}`,
      user_agent: "Mozilla/5.0", device: pick(["Desktop", "Mobile"]),
      browser: pick(["Chrome", "Firefox", "Safari"]),
      created_at: now - rand(0, 7 * day),
      last_seen_at: now - rand(0, 3600),
      current: i === 0,
    })),
  }),
  numberSummary: () => ({
    today: { c: 23, s: 18 }, week: { c: 142, s: 118 },
    month: { c: 587, s: 487 }, active: 7,
  }),
  myNumbers: () => demoData.allocations(),
  myCdr: () => demoData.cdr(),
  myPayments: () => demoData.payments(),
  myWithdrawals: () => demoData.withdrawals(),
  providers: () => ({
    providers: PROVIDERS.map(id => ({ id, name: id.replace("_", " ").toUpperCase() })),
  }),
  countries: () => ({
    countries: [
      { id: 1, name: "Bangladesh", code: "BD" },
      { id: 2, name: "India", code: "IN" },
      { id: 3, name: "Pakistan", code: "PK" },
      { id: 4, name: "Indonesia", code: "ID" },
      { id: 5, name: "Philippines", code: "PH" },
      { id: 6, name: "Vietnam", code: "VN" },
    ],
  }),
  operators: () => ({
    operators: [
      { id: 1, name: "Grameenphone" },
      { id: 2, name: "Robi" },
      { id: 3, name: "Banglalink" },
      { id: 4, name: "Airtel" },
      { id: 5, name: "Any" },
    ],
  }),
  getNumber: () => ({
    allocated: [{
      id: Date.now(),
      phone_number: `+88017${rand(10000000, 99999999)}`,
      operator: pick(["Grameen", "Robi", "Banglalink"]),
      otp: null,
      status: "active",
    }],
    errors: [] as string[],
  }),
  settings: () => ({ signup_enabled: true }),
  settingsAll: () => ({ settings: { signup_enabled: "true" } }),
};

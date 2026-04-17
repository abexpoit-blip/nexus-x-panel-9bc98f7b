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

// Real country + operator catalog (mirrors AccHub + IMS coverage) — price in BDT
const COUNTRY_CATALOG: { id: number; name: string; code: string; flag: string; price: number; operators: string[] }[] = [
  { id: 1,  name: "Bangladesh",   code: "880",  flag: "🇧🇩", price: 8,   operators: ["Grameenphone", "Robi", "Banglalink", "Airtel", "Teletalk", "Any"] },
  { id: 2,  name: "India",        code: "91",   flag: "🇮🇳", price: 12,  operators: ["Jio", "Airtel", "Vi (Vodafone Idea)", "BSNL", "Any"] },
  { id: 3,  name: "Pakistan",     code: "92",   flag: "🇵🇰", price: 14,  operators: ["Jazz", "Zong", "Telenor", "Ufone", "Any"] },
  { id: 4,  name: "Indonesia",    code: "62",   flag: "🇮🇩", price: 15,  operators: ["Telkomsel", "Indosat", "XL Axiata", "Tri", "Smartfren", "Any"] },
  { id: 5,  name: "Philippines",  code: "63",   flag: "🇵🇭", price: 18,  operators: ["Globe", "Smart", "DITO", "TNT", "Any"] },
  { id: 6,  name: "Vietnam",      code: "84",   flag: "🇻🇳", price: 16,  operators: ["Viettel", "Vinaphone", "Mobifone", "Vietnamobile", "Any"] },
  { id: 7,  name: "Nigeria",      code: "234",  flag: "🇳🇬", price: 22,  operators: ["MTN", "Airtel", "Glo", "9mobile", "Any"] },
  { id: 8,  name: "Kenya",        code: "254",  flag: "🇰🇪", price: 20,  operators: ["Safaricom", "Airtel", "Telkom", "Any"] },
  { id: 9,  name: "Myanmar",      code: "95",   flag: "🇲🇲", price: 17,  operators: ["MPT", "Ooredoo", "Atom (Telenor)", "Mytel", "Any"] },
  { id: 10, name: "Sri Lanka",    code: "94",   flag: "🇱🇰", price: 13,  operators: ["Dialog", "Mobitel", "Hutch", "Airtel", "Any"] },
  { id: 11, name: "Nepal",        code: "977",  flag: "🇳🇵", price: 14,  operators: ["Ncell", "NTC", "Smart Cell", "Any"] },
  { id: 12, name: "Cambodia",     code: "855",  flag: "🇰🇭", price: 19,  operators: ["Smart", "Cellcard", "Metfone", "Any"] },
  { id: 13, name: "Thailand",     code: "66",   flag: "🇹🇭", price: 21,  operators: ["AIS", "TrueMove", "DTAC", "Any"] },
  { id: 14, name: "Malaysia",     code: "60",   flag: "🇲🇾", price: 24,  operators: ["Maxis", "Celcom", "Digi", "U Mobile", "Any"] },
  { id: 15, name: "UAE",          code: "971",  flag: "🇦🇪", price: 35,  operators: ["Etisalat", "du", "Any"] },
  { id: 16, name: "Saudi Arabia", code: "966",  flag: "🇸🇦", price: 32,  operators: ["STC", "Mobily", "Zain", "Any"] },
  { id: 17, name: "Egypt",        code: "20",   flag: "🇪🇬", price: 18,  operators: ["Vodafone", "Orange", "Etisalat", "WE", "Any"] },
  { id: 18, name: "South Africa", code: "27",   flag: "🇿🇦", price: 25,  operators: ["Vodacom", "MTN", "Cell C", "Telkom", "Any"] },
  { id: 19, name: "Brazil",       code: "55",   flag: "🇧🇷", price: 23,  operators: ["Vivo", "Claro", "TIM", "Oi", "Any"] },
  { id: 20, name: "Mexico",       code: "52",   flag: "🇲🇽", price: 26,  operators: ["Telcel", "Movistar", "AT&T", "Any"] },
  { id: 21, name: "USA",          code: "1",    flag: "🇺🇸", price: 45,  operators: ["Verizon", "T-Mobile", "AT&T", "Any"] },
  { id: 22, name: "UK",           code: "44",   flag: "🇬🇧", price: 38,  operators: ["EE", "O2", "Vodafone", "Three", "Any"] },
  { id: 23, name: "Russia",       code: "7",    flag: "🇷🇺", price: 28,  operators: ["MTS", "MegaFon", "Beeline", "Tele2", "Any"] },
  { id: 24, name: "Turkey",       code: "90",   flag: "🇹🇷", price: 27,  operators: ["Turkcell", "Vodafone", "Türk Telekom", "Any"] },
  { id: 25, name: "China",        code: "86",   flag: "🇨🇳", price: 30,  operators: ["China Mobile", "China Unicom", "China Telecom", "Any"] },
];

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
    todayCommission: 6_847.25,
    totalCommission: 184_320.75,
    pendingWithdrawals: 3,
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
  myNumbers: () => ({ numbers: demoAllocations.list() }),
  myCdr: () => demoData.cdr(),
  myPayments: () => demoData.payments(),
  myWithdrawals: () => demoData.withdrawals(),
  providers: () => ({
    providers: PROVIDERS.map(id => ({ id, name: id.replace("_", " ").toUpperCase() })),
  }),
  countries: () => ({
    countries: COUNTRY_CATALOG.map(({ id, name, code, flag, price }) => ({
      id, name: `${flag} ${name} (+${code})`, code, flag, price_bdt: price,
    })),
  }),
  operators: (countryId?: number) => {
    const c = COUNTRY_CATALOG.find(x => x.id === countryId);
    const ops = c?.operators ?? ["Any"];
    const base = c?.price ?? 10;
    return {
      operators: ops.map((name, i) => ({
        id: i + 1,
        name,
        price_bdt: name === "Any" ? base : base + (i % 3),
      })),
    };
  },
  pricing: () => ({
    pricing: COUNTRY_CATALOG.map(({ id, name, code, flag, price, operators }) => ({
      id, name, code, flag, price_bdt: price, operator_count: operators.length,
    })),
  }),
  getNumber: (countryId?: number, operatorId?: number) => {
    const c = COUNTRY_CATALOG.find(x => x.id === countryId);
    const opName = c?.operators?.[(operatorId ?? 1) - 1] || "Any";
    return { allocated: [demoAllocations.allocate(c?.code || "880", opName)], errors: [] as string[] };
  },
  syncOtp: () => ({ updated: demoAllocations.tickOtp() }),
  settings: () => {
    const m = typeof localStorage !== "undefined" && localStorage.getItem("nexus_maintenance_mode") === "true";
    const msg = (typeof localStorage !== "undefined" && localStorage.getItem("nexus_maintenance_message")) || "System is under maintenance. Please try again later.";
    return { signup_enabled: true, maintenance_mode: m, maintenance_message: msg };
  },
  settingsAll: () => ({ settings: {
    signup_enabled: "true",
    maintenance_mode: String(typeof localStorage !== "undefined" && localStorage.getItem("nexus_maintenance_mode") === "true"),
  } }),
};

// In-memory allocations for demo mode — OTP auto-fills 4-8s after allocation
const demoAllocations = (() => {
  type Item = { id: number; phone_number: string; operator: string; otp: string | null; status: string; created_at: number; otp_at: number };
  const items: Item[] = [];
  return {
    list: () => items.slice(),
    allocate: (countryCode = "880", operator?: string): Item => {
      // Generate a plausible local subscriber number (8-9 digits)
      const subscriber = `${rand(100000000, 999999999)}`.slice(0, rand(8, 10));
      const n: Item = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        phone_number: `+${countryCode}${subscriber}`,
        operator: operator || pick(["Grameenphone", "Robi", "Banglalink", "Airtel"]),
        otp: null,
        status: "active",
        created_at: Math.floor(Date.now() / 1000),
        otp_at: Math.floor(Date.now() / 1000) + rand(4, 8),
      };
      items.unshift(n);
      if (items.length > 50) items.length = 50;
      return n;
    },
    tickOtp: () => {
      const now = Math.floor(Date.now() / 1000);
      let updated = 0;
      for (const n of items) {
        if (!n.otp && n.otp_at && now >= n.otp_at) {
          n.otp = String(rand(100000, 999999));
          n.status = "received";
          updated++;
        }
      }
      return updated;
    },
  };
})();

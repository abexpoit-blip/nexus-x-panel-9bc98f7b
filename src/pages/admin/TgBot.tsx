import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { GradientMesh, PageHeader } from "@/components/premium";
import {
  Bot, Users, Send, Activity, Wallet, MessageSquare, RefreshCw, Search,
  CheckCircle2, XCircle, Power, Plus, Megaphone, ToggleLeft, ToggleRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type TgUser = {
  tg_user_id: number; username: string | null; first_name: string | null;
  balance_bdt: number; total_otps: number; total_spent: number;
  status: string; created_at: number; last_seen_at: number;
};

const fmtBdt = (n: number) => `৳${(n || 0).toFixed(2)}`;
const fmtAgo = (s: number) => {
  const d = Math.floor(Date.now() / 1000) - s;
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
};
const flagOf = (cc?: string | null) => {
  if (!cc || cc.length !== 2) return "🌐";
  return String.fromCodePoint(0x1F1E6 + cc.charCodeAt(0) - 65) +
         String.fromCodePoint(0x1F1E6 + cc.charCodeAt(1) - 65);
};
const COUNTRY_NAMES: Record<string, string> = {
  AF:"Afghanistan",AL:"Albania",DZ:"Algeria",AR:"Argentina",AM:"Armenia",AU:"Australia",AT:"Austria",AZ:"Azerbaijan",
  BD:"Bangladesh",BY:"Belarus",BE:"Belgium",BO:"Bolivia",BR:"Brazil",BG:"Bulgaria",KH:"Cambodia",CM:"Cameroon",
  CA:"Canada",CL:"Chile",CN:"China",CO:"Colombia",CR:"Costa Rica",HR:"Croatia",CU:"Cuba",CY:"Cyprus",CZ:"Czechia",
  DK:"Denmark",DO:"Dominican Republic",EC:"Ecuador",EG:"Egypt",SV:"El Salvador",EE:"Estonia",ET:"Ethiopia",FI:"Finland",
  FR:"France",GE:"Georgia",DE:"Germany",GH:"Ghana",GR:"Greece",GT:"Guatemala",HN:"Honduras",HK:"Hong Kong",HU:"Hungary",
  IS:"Iceland",IN:"India",ID:"Indonesia",IR:"Iran",IQ:"Iraq",IE:"Ireland",IL:"Israel",IT:"Italy",JM:"Jamaica",JP:"Japan",
  JO:"Jordan",KZ:"Kazakhstan",KE:"Kenya",KW:"Kuwait",KG:"Kyrgyzstan",LA:"Laos",LV:"Latvia",LB:"Lebanon",LY:"Libya",
  LT:"Lithuania",LU:"Luxembourg",MO:"Macao",MY:"Malaysia",ML:"Mali",MT:"Malta",MX:"Mexico",MD:"Moldova",MN:"Mongolia",
  MA:"Morocco",MM:"Myanmar",NP:"Nepal",NL:"Netherlands",NZ:"New Zealand",NI:"Nicaragua",NG:"Nigeria",NO:"Norway",
  OM:"Oman",PK:"Pakistan",PA:"Panama",PY:"Paraguay",PE:"Peru",PH:"Philippines",PL:"Poland",PT:"Portugal",PR:"Puerto Rico",
  QA:"Qatar",RO:"Romania",RU:"Russia",SA:"Saudi Arabia",RS:"Serbia",SG:"Singapore",SK:"Slovakia",SI:"Slovenia",
  ZA:"South Africa",KR:"South Korea",ES:"Spain",LK:"Sri Lanka",SD:"Sudan",SE:"Sweden",CH:"Switzerland",SY:"Syria",
  TW:"Taiwan",TJ:"Tajikistan",TZ:"Tanzania",TH:"Thailand",TR:"Turkey",TM:"Turkmenistan",UG:"Uganda",UA:"Ukraine",
  AE:"UAE",GB:"United Kingdom",US:"United States",UY:"Uruguay",UZ:"Uzbekistan",VE:"Venezuela",VN:"Vietnam",YE:"Yemen",
  ZM:"Zambia",ZW:"Zimbabwe",
};
const countryName = (cc?: string | null) => (cc && COUNTRY_NAMES[cc.toUpperCase()]) || cc || "Unknown";
const serviceIcon = (s?: string | null) => {
  const x = (s || "").toLowerCase();
  if (x.includes("facebook"))  return "[FB]";
  if (x.includes("whatsapp"))  return "[WA]";
  if (x.includes("telegram"))  return "[TG]";
  if (x.includes("tiktok"))    return "[TT]";
  if (x.includes("instagram")) return "[IG]";
  if (x.includes("google"))    return "[GG]";
  return "[SMS]";
};

export default function TgBot() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"overview" | "ranges" | "users" | "broadcast" | "feed">("overview");

  const status = useQuery({
    queryKey: ["tgbot-status"],
    queryFn: () => api.tgbot.status(),
    refetchInterval: 5000,
  });

  return (
    <div className="relative min-h-screen">
      <GradientMesh />
      <div className="relative z-10 max-w-[1500px] mx-auto p-6 space-y-6">
        <PageHeader
          icon={<Bot className="w-8 h-8" />}
          eyebrow="Workers"
          title="Telegram Bot"
          description="NEXUS X Number Panel — control TG range availability, users, broadcasts"
          actions={
            <button
              onClick={() => { status.refetch(); qc.invalidateQueries(); }}
              className="px-3 py-2 rounded-lg bg-white/[0.04] border border-white/10 text-xs font-semibold hover:bg-white/[0.08] flex items-center gap-2"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Refresh
            </button>
          }
        />

        {/* ---- KPIs ---- */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Kpi icon={<Users className="w-4 h-4" />} label="Total TG Users"
               value={status.data?.totalUsers ?? 0} accent="neon-cyan" />
          <Kpi icon={<Activity className="w-4 h-4" />} label="Online (10m)"
               value={status.data?.onlineUsers ?? 0} accent="neon-green" />
          <Kpi icon={<MessageSquare className="w-4 h-4" />} label="Today OTPs"
               value={status.data?.todayOtps ?? 0} accent="neon-magenta" />
          <Kpi icon={<Wallet className="w-4 h-4" />} label="Total Revenue"
               value={fmtBdt(status.data?.totalRevenue ?? 0)} accent="neon-gold" />
          <Kpi icon={<Send className="w-4 h-4" />} label="Active Numbers"
               value={status.data?.activeNumbers ?? 0} accent="neon-cyan" />
          <Kpi icon={<CheckCircle2 className="w-4 h-4" />} label="Total Delivered"
               value={status.data?.totalDelivered ?? 0} accent="neon-green" />
          <Kpi icon={<ToggleRight className="w-4 h-4" />} label="TG-Enabled Ranges"
               value={status.data?.enabledRanges ?? 0} accent="neon-magenta" />
          <Kpi icon={<Power className="w-4 h-4" />} label="Active Users"
               value={status.data?.activeUsers ?? 0} accent="neon-gold" />
        </div>

        {/* ---- Tabs ---- */}
        <div className="flex flex-wrap gap-2 border-b border-white/10 pb-1">
          {([
            ["overview", "Overview", Bot],
            ["ranges", "Range Toggles", ToggleRight],
            ["users", "TG Users", Users],
            ["broadcast", "Broadcast", Megaphone],
            ["feed", "Live OTP Feed", Activity],
          ] as const).map(([k, label, Icon]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={cn(
                "px-4 py-2 rounded-t-lg text-xs font-semibold flex items-center gap-2 transition",
                tab === k
                  ? "bg-primary/20 text-primary border-b-2 border-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/[0.04]"
              )}
            >
              <Icon className="w-3.5 h-3.5" /> {label}
            </button>
          ))}
        </div>

        {tab === "overview" && <OverviewTab />}
        {tab === "ranges" && <RangesTab />}
        {tab === "users" && <UsersTab />}
        {tab === "broadcast" && <BroadcastTab />}
        {tab === "feed" && <FeedTab />}
      </div>
    </div>
  );
}

function Kpi({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: any; accent: string }) {
  return (
    <div className="glass-premium p-4 rounded-xl border border-white/[0.06]">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
        <span className={cn(`text-${accent}`)}>{icon}</span>
        {label}
      </div>
      <div className={cn("text-2xl font-display font-bold", `text-${accent}`)}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
    </div>
  );
}

// ============================================================
// OVERVIEW
// ============================================================
function OverviewTab() {
  const [savingExpiry, setSavingExpiry] = useState(false);
  const qc = useQueryClient();
  const { data: expiry, refetch: refetchExpiry, isLoading: expiryLoading } = useQuery({
    queryKey: ["tgbot-otp-expiry"],
    queryFn: () => api.admin.otpExpiry(),
  });
  const { data: cfg, refetch: refetchCfg } = useQuery({
    queryKey: ["tgbot-config"],
    queryFn: () => api.tgbot.config(),
  });
  const billingOn = cfg?.tg_billing_enabled !== "0";
  const [savingBilling, setSavingBilling] = useState(false);

  const toggleBilling = async () => {
    setSavingBilling(true);
    try {
      await api.tgbot.saveConfig({ tg_billing_enabled: billingOn ? "0" : "1" });
      toast.success(billingOn
        ? "Billing OFF — bot now in FREE mode (no balance / no charges)"
        : "Billing ON — wallet + per-OTP charges resumed");
      await refetchCfg();
      qc.invalidateQueries({ queryKey: ["tgbot-status"] });
    } catch (e) {
      toast.error("Failed: " + (e as Error).message);
    } finally {
      setSavingBilling(false);
    }
  };

  const currentMin = expiry?.expiry_min ?? 30;
  const expiryOpts = expiry?.options_min ?? [5, 8, 10, 15, 20, 30];

  const saveExpiry = async (min: number) => {
    if (min === currentMin) return;
    setSavingExpiry(true);
    try {
      await api.admin.otpExpirySave(min);
      toast.success(`OTP expiry set to ${min} min — shared across website + Telegram bot`);
      await refetchExpiry();
    } catch (e) {
      toast.error("Failed: " + (e as Error).message);
    } finally {
      setSavingExpiry(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="glass-premium p-6 rounded-xl border border-white/[0.06] text-sm space-y-3">
        <h3 className="text-base font-display font-bold flex items-center gap-2">
          <Bot className="w-5 h-5 text-primary" /> NEXUS X Number Panel — TG Bot
        </h3>
        <p className="text-muted-foreground leading-relaxed">
          This bot runs as <code className="text-neon-cyan">nexus-tgbot</code> — a separate pm2 process
          sharing the same number pool as the website. Users browse country &amp; range,
          get a batch of <b>10 numbers</b> per request, and OTPs are pushed to them automatically with a
          copy-to-clipboard <code className="text-neon-magenta">Number|OTP</code> format.
        </p>
        <ul className="space-y-2 text-muted-foreground">
          <li>• ⏱ Numbers auto-expire after <b>{currentMin} min</b> if no OTP — returned to pool.</li>
          <li>• 🔄 Users with active numbers can request more without losing existing ones.</li>
          <li>• 💰 Each OTP success deducts the per-range rate (admin sets).</li>
          <li>• 🔍 Active Range Checker shows top countries + top ranges.</li>
          <li>• 📣 Broadcast a message to all active TG users from the Broadcast tab.</li>
        </ul>
        <div className="text-xs text-muted-foreground pt-2 border-t border-white/[0.05]">
          Manage which ranges are exposed to the bot in <b>Range Toggles</b>. Only enabled ranges with
          pool &gt; 0 appear in the bot menu.
        </div>
      </div>

      <div className="glass-premium p-5 rounded-xl border border-white/[0.06] space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <Activity className="w-4 h-4 text-primary" /> Shared Number Expiry Window
            </h3>
            <p className="text-xs text-muted-foreground mt-1">
              One setting for both website panel and Telegram bot. Agents and TG users follow the same timer.
              <span className="ml-2 font-mono">
                Current: <span className="text-primary font-semibold">{currentMin} min</span>
                {expiry && <span className="text-muted-foreground/60"> ({expiry.source})</span>}
              </span>
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {expiryOpts.map((v) => (
              <button
                key={v}
                onClick={() => saveExpiry(v)}
                disabled={savingExpiry || expiryLoading}
                className={cn(
                  "px-4 py-2 rounded-md text-xs font-semibold border transition disabled:opacity-50",
                  v === currentMin
                    ? "bg-primary/15 border-primary/40 text-primary"
                    : "bg-white/[0.04] border-white/[0.08] text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
                )}
              >
                {v}m
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ---- Billing / Wallet master switch ---- */}
      <div className={cn(
        "glass-premium p-5 rounded-xl border space-y-3 transition",
        billingOn ? "border-neon-green/30" : "border-neon-magenta/30"
      )}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex-1 min-w-[260px]">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <Wallet className={cn("w-4 h-4", billingOn ? "text-neon-green" : "text-neon-magenta")} />
              TG Bot Billing &amp; Wallet
            </h3>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              Master switch for the Telegram bot's revenue system. When <b>OFF</b>:
              wallet balance is hidden, no per-OTP charges, no top-ups required —
              users get unlimited FREE access to all enabled ranges. Range rates stay
              saved so you can flip back ON anytime without re-configuring.
            </p>
            <p className="text-[11px] mt-2 font-mono">
              Status: <span className={cn("font-semibold", billingOn ? "text-neon-green" : "text-neon-magenta")}>
                {billingOn ? "● BILLING ENABLED (wallet + charges)" : "○ FREE MODE (no charges)"}
              </span>
            </p>
          </div>
          <button
            onClick={toggleBilling}
            disabled={savingBilling || !cfg}
            className={cn(
              "px-5 py-2.5 rounded-lg text-sm font-bold border transition disabled:opacity-50 flex items-center gap-2",
              billingOn
                ? "bg-neon-magenta/15 border-neon-magenta/40 text-neon-magenta hover:bg-neon-magenta/25"
                : "bg-neon-green/15 border-neon-green/40 text-neon-green hover:bg-neon-green/25"
            )}
          >
            {billingOn ? <><ToggleLeft className="w-4 h-4" /> Turn OFF (FREE mode)</>
                       : <><ToggleRight className="w-4 h-4" /> Turn ON (charge per OTP)</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// RANGE TOGGLES
// ============================================================
function RangesTab() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState("");
  const [editingRate, setEditingRate] = useState<Record<string, number>>({});
  const [editingService, setEditingService] = useState<Record<string, string>>({});

  const ranges = useQuery({
    queryKey: ["tgbot-ranges"],
    queryFn: () => api.tgbot.rangeSettings(),
    refetchInterval: 10000,
  });

  const filtered = useMemo(() => {
    const list = ranges.data?.ranges || [];
    if (!filter) return list;
    const f = filter.toLowerCase();
    return list.filter(r =>
      r.range_name.toLowerCase().includes(f) ||
      (r.country_code || "").toLowerCase().includes(f) ||
      r.provider.toLowerCase().includes(f)
    );
  }, [ranges.data, filter]);

  const toggleRange = async (r: any, enabled: boolean) => {
    const key = `${r.provider}::${r.range_name}`;
    const rate = editingRate[key] ?? r.tg_rate_bdt;
    const service = editingService[key] ?? r.service;
    await api.tgbot.updateRange({
      provider: r.provider, range_name: r.range_name,
      tg_enabled: enabled, tg_rate_bdt: rate, service,
    });
    toast.success(enabled ? "Range enabled for TG" : "Range disabled");
    qc.invalidateQueries({ queryKey: ["tgbot-ranges"] });
    qc.invalidateQueries({ queryKey: ["tgbot-status"] });
  };

  const saveRate = async (r: any) => {
    const key = `${r.provider}::${r.range_name}`;
    const rate = editingRate[key] ?? r.tg_rate_bdt;
    const service = editingService[key] ?? r.service;
    await api.tgbot.updateRange({
      provider: r.provider, range_name: r.range_name,
      tg_enabled: r.tg_enabled, tg_rate_bdt: rate, service,
    });
    toast.success("Saved");
    setEditingRate(prev => { const n = { ...prev }; delete n[key]; return n; });
    setEditingService(prev => { const n = { ...prev }; delete n[key]; return n; });
    qc.invalidateQueries({ queryKey: ["tgbot-ranges"] });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter by range, country, provider..."
            className="w-full pl-10 pr-3 py-2 rounded-lg bg-white/[0.04] border border-white/10 text-sm focus:outline-none focus:border-primary/50"
          />
        </div>
        <span className="text-xs text-muted-foreground">{filtered.length} ranges</span>
      </div>

      <div className="glass-premium rounded-xl border border-white/[0.06] overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-white/[0.03] text-muted-foreground uppercase tracking-wider">
            <tr>
              <th className="text-left py-3 px-4">Provider</th>
              <th className="text-left py-3 px-4">Country</th>
              <th className="text-left py-3 px-4">Range</th>
              <th className="text-right py-3 px-4">Pool</th>
              <th className="text-left py-3 px-4">Service</th>
              <th className="text-right py-3 px-4">Rate (BDT)</th>
              <th className="text-center py-3 px-4">TG Enabled</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(r => {
              const key = `${r.provider}::${r.range_name}`;
              const rateVal = editingRate[key] ?? r.tg_rate_bdt;
              const svcVal = editingService[key] ?? (r.service || "");
              const dirty = (key in editingRate) || (key in editingService);
              return (
                <tr key={key} className="border-t border-white/[0.04] hover:bg-white/[0.02]">
                  <td className="py-2.5 px-4 uppercase font-mono text-[10px] text-neon-cyan">{r.provider}</td>
                  <td className="py-2.5 px-4">
                    <span className="text-base mr-1.5">{flagOf(r.country_code)}</span>
                    <span className="font-medium">{countryName(r.country_code)}</span>
                    <span className="text-muted-foreground ml-1.5 text-[10px] font-mono">{r.country_code || "—"}</span>
                  </td>
                  <td className="py-2.5 px-4 font-medium">
                    <span className="mr-1.5">{flagOf(r.country_code)}</span>{r.range_name}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono text-neon-green">{r.pool_count.toLocaleString()}</td>
                  <td className="py-2.5 px-4">
                    <select
                      value={svcVal}
                      onChange={e => setEditingService(p => ({ ...p, [key]: e.target.value }))}
                      onBlur={() => dirty && saveRate(r)}
                      className="bg-white/[0.04] border border-white/10 rounded px-2 py-1 text-xs"
                    >
                      <option value="">—</option>
                      <option value="facebook">[FB] Facebook</option>
                      <option value="whatsapp">[WA] WhatsApp</option>
                      <option value="telegram">[TG] Telegram</option>
                      <option value="tiktok">[TT] TikTok</option>
                      <option value="instagram">[IG] Instagram</option>
                      <option value="google">[GG] Google</option>
                      <option value="other">[SMS] Other</option>
                    </select>
                  </td>
                  <td className="py-2.5 px-4 text-right">
                    <input
                      type="number" step="0.01" min="0" value={rateVal}
                      onChange={e => setEditingRate(p => ({ ...p, [key]: +e.target.value }))}
                      onBlur={() => dirty && saveRate(r)}
                      className="w-20 text-right bg-white/[0.04] border border-white/10 rounded px-2 py-1 text-xs"
                    />
                  </td>
                  <td className="py-2.5 px-4 text-center">
                    <button
                      onClick={() => toggleRange(r, !r.tg_enabled)}
                      className={cn(
                        "px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider transition",
                        r.tg_enabled
                          ? "bg-neon-green/20 text-neon-green border border-neon-green/30"
                          : "bg-white/[0.04] text-muted-foreground border border-white/10 hover:border-white/30"
                      )}
                    >
                      {r.tg_enabled ? "ON" : "OFF"}
                    </button>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={7} className="text-center py-8 text-muted-foreground">No ranges in pool yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================
// USERS
// ============================================================
function UsersTab() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [topupUser, setTopupUser] = useState<TgUser | null>(null);
  const [topupAmount, setTopupAmount] = useState(0);
  const [topupNote, setTopupNote] = useState("");

  const users = useQuery({
    queryKey: ["tgbot-users", page, q],
    queryFn: () => api.tgbot.users({ page, page_size: 50, q }),
  });

  const submitTopup = async () => {
    if (!topupUser || !topupAmount) return;
    await api.tgbot.topup(topupUser.tg_user_id, topupAmount, topupNote);
    toast.success(`Top-up applied: ${fmtBdt(topupAmount)}`);
    setTopupUser(null); setTopupAmount(0); setTopupNote("");
    qc.invalidateQueries({ queryKey: ["tgbot-users"] });
  };

  const toggleBan = async (u: TgUser) => {
    if (!confirm(`${u.status === "banned" ? "Unban" : "Ban"} ${u.username || u.first_name || u.tg_user_id}?`)) return;
    await api.tgbot.ban(u.tg_user_id, u.status !== "banned");
    toast.success("Status updated");
    qc.invalidateQueries({ queryKey: ["tgbot-users"] });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q} onChange={e => { setQ(e.target.value); setPage(1); }}
            placeholder="Search username, name, or TG ID..."
            className="w-full pl-10 pr-3 py-2 rounded-lg bg-white/[0.04] border border-white/10 text-sm focus:outline-none focus:border-primary/50"
          />
        </div>
        <span className="text-xs text-muted-foreground">{users.data?.total ?? 0} users</span>
      </div>

      <div className="glass-premium rounded-xl border border-white/[0.06] overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-white/[0.03] text-muted-foreground uppercase tracking-wider">
            <tr>
              <th className="text-left py-3 px-4">TG ID</th>
              <th className="text-left py-3 px-4">Username</th>
              <th className="text-left py-3 px-4">Name</th>
              <th className="text-right py-3 px-4">Balance</th>
              <th className="text-right py-3 px-4">OTPs</th>
              <th className="text-right py-3 px-4">Spent</th>
              <th className="text-left py-3 px-4">Last Seen</th>
              <th className="text-center py-3 px-4">Status</th>
              <th className="text-right py-3 px-4">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.data?.rows.map(u => (
              <tr key={u.tg_user_id} className="border-t border-white/[0.04] hover:bg-white/[0.02]">
                <td className="py-2.5 px-4 font-mono text-[10px] text-muted-foreground">{u.tg_user_id}</td>
                <td className="py-2.5 px-4">{u.username ? `@${u.username}` : "—"}</td>
                <td className="py-2.5 px-4">{u.first_name || "—"}</td>
                <td className="py-2.5 px-4 text-right font-mono text-neon-green">{fmtBdt(u.balance_bdt)}</td>
                <td className="py-2.5 px-4 text-right">{u.total_otps}</td>
                <td className="py-2.5 px-4 text-right text-muted-foreground">{fmtBdt(u.total_spent)}</td>
                <td className="py-2.5 px-4 text-muted-foreground">{fmtAgo(u.last_seen_at)}</td>
                <td className="py-2.5 px-4 text-center">
                  <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-bold uppercase",
                    u.status === "active" ? "bg-neon-green/20 text-neon-green" : "bg-neon-red/20 text-neon-red"
                  )}>{u.status}</span>
                </td>
                <td className="py-2.5 px-4 text-right space-x-2">
                  <button
                    onClick={() => setTopupUser(u)}
                    className="px-2 py-1 rounded text-[10px] bg-neon-cyan/10 text-neon-cyan border border-neon-cyan/30 hover:bg-neon-cyan/20"
                  >
                    <Plus className="w-3 h-3 inline" /> Top-up
                  </button>
                  <button
                    onClick={() => toggleBan(u)}
                    className="px-2 py-1 rounded text-[10px] bg-neon-red/10 text-neon-red border border-neon-red/30 hover:bg-neon-red/20"
                  >
                    {u.status === "banned" ? "Unban" : "Ban"}
                  </button>
                </td>
              </tr>
            ))}
            {users.data?.rows.length === 0 && (
              <tr><td colSpan={9} className="text-center py-8 text-muted-foreground">No TG users yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {users.data && users.data.total_pages > 1 && (
        <div className="flex justify-center gap-2">
          <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}
            className="px-3 py-1.5 rounded bg-white/[0.04] border border-white/10 text-xs disabled:opacity-40">Prev</button>
          <span className="px-3 py-1.5 text-xs">{page} / {users.data.total_pages}</span>
          <button disabled={page >= users.data.total_pages} onClick={() => setPage(p => p + 1)}
            className="px-3 py-1.5 rounded bg-white/[0.04] border border-white/10 text-xs disabled:opacity-40">Next</button>
        </div>
      )}

      {/* Top-up dialog */}
      {topupUser && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => setTopupUser(null)}>
          <div className="glass-premium rounded-xl p-6 max-w-md w-full border border-white/10" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-display font-bold mb-4">
              💰 Top-up {topupUser.username ? `@${topupUser.username}` : topupUser.first_name}
            </h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs uppercase text-muted-foreground tracking-wider">Amount (BDT, negative = deduct)</label>
                <input type="number" step="0.01" value={topupAmount}
                  onChange={e => setTopupAmount(+e.target.value)}
                  className="w-full mt-1 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/10 text-sm" />
              </div>
              <div>
                <label className="text-xs uppercase text-muted-foreground tracking-wider">Note (optional)</label>
                <input type="text" value={topupNote}
                  onChange={e => setTopupNote(e.target.value)}
                  className="w-full mt-1 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/10 text-sm" />
              </div>
              <div className="flex gap-2 justify-end pt-2">
                <button onClick={() => setTopupUser(null)} className="px-4 py-2 rounded-lg text-sm text-muted-foreground hover:bg-white/[0.04]">Cancel</button>
                <button onClick={submitTopup} className="px-4 py-2 rounded-lg text-sm font-semibold bg-primary/20 text-primary border border-primary/30 hover:bg-primary/30">Apply</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// BROADCAST
// ============================================================
function BroadcastTab() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState("");
  const broadcasts = useQuery({
    queryKey: ["tgbot-broadcasts"],
    queryFn: () => api.tgbot.broadcasts(),
    refetchInterval: 4000,
  });
  const send = async () => {
    if (!msg.trim()) return;
    if (!confirm(`Send to ALL active TG users?\n\n${msg.slice(0, 200)}`)) return;
    await api.tgbot.broadcast(msg);
    toast.success("Broadcast queued");
    setMsg("");
    qc.invalidateQueries({ queryKey: ["tgbot-broadcasts"] });
  };
  return (
    <div className="space-y-4">
      <div className="glass-premium rounded-xl p-5 border border-white/[0.06] space-y-3">
        <h3 className="font-display font-semibold flex items-center gap-2">
          <Megaphone className="w-4 h-4 text-neon-magenta" /> Compose Broadcast
        </h3>
        <p className="text-xs text-muted-foreground">
          HTML supported: <code>&lt;b&gt;</code>, <code>&lt;i&gt;</code>, <code>&lt;code&gt;</code>, <code>&lt;a&gt;</code>. Sent at 30 msg/sec.
        </p>
        <p className="text-[11px] text-neon-cyan/80 bg-neon-cyan/[0.04] border border-neon-cyan/20 rounded-md px-3 py-2">
          📣 Broadcasts are sent as <b>private DMs</b> to every active TG user <b>and</b> mirrored to the
          configured public channel (Overview → <code>tg_public_channel</code>). Users who never opened the bot
          privately will only see it in the channel.
        </p>
        <textarea
          value={msg} onChange={e => setMsg(e.target.value)} rows={5}
          placeholder="🎉 Big news! New ranges added..."
          className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/10 text-sm font-mono focus:outline-none focus:border-primary/50"
        />
        <div className="flex justify-between items-center">
          <span className="text-xs text-muted-foreground">{msg.length} chars</span>
          <button onClick={send} disabled={!msg.trim()}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-neon-magenta/20 text-neon-magenta border border-neon-magenta/30 hover:bg-neon-magenta/30 disabled:opacity-40 flex items-center gap-2">
            <Send className="w-4 h-4" /> Send to all
          </button>
        </div>
      </div>

      <div className="glass-premium rounded-xl border border-white/[0.06] overflow-hidden">
        <div className="p-4 border-b border-white/[0.05] text-sm font-semibold">Recent Broadcasts</div>
        <table className="w-full text-xs">
          <thead className="bg-white/[0.03] text-muted-foreground uppercase tracking-wider">
            <tr>
              <th className="text-left py-2.5 px-4">When</th>
              <th className="text-left py-2.5 px-4">Admin</th>
              <th className="text-left py-2.5 px-4">Message</th>
              <th className="text-center py-2.5 px-4">Status</th>
              <th className="text-right py-2.5 px-4">Sent / Failed</th>
            </tr>
          </thead>
          <tbody>
            {broadcasts.data?.broadcasts.map(b => (
              <tr key={b.id} className="border-t border-white/[0.04]">
                <td className="py-2 px-4 text-muted-foreground">{fmtAgo(b.created_at)}</td>
                <td className="py-2 px-4">{b.admin_username || "—"}</td>
                <td className="py-2 px-4 truncate max-w-[400px]">{b.message.slice(0, 80)}</td>
                <td className="py-2 px-4 text-center">
                  <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-bold uppercase",
                    b.status === "done" ? "bg-neon-green/20 text-neon-green" :
                    b.status === "sending" ? "bg-neon-cyan/20 text-neon-cyan" :
                    b.status === "failed" ? "bg-neon-red/20 text-neon-red" :
                    "bg-white/[0.05] text-muted-foreground"
                  )}>{b.status}</span>
                </td>
                <td className="py-2 px-4 text-right font-mono">
                  <span className="text-neon-green">{b.sent_count}</span> / <span className="text-neon-red">{b.failed_count}</span>
                </td>
              </tr>
            ))}
            {broadcasts.data?.broadcasts.length === 0 && (
              <tr><td colSpan={5} className="text-center py-8 text-muted-foreground">No broadcasts yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================
// LIVE FEED
// ============================================================
function FeedTab() {
  const feed = useQuery({
    queryKey: ["tgbot-feed"],
    queryFn: () => api.tgbot.otpFeed(50),
    refetchInterval: 3000,
  });
  return (
    <div className="glass-premium rounded-xl border border-white/[0.06] overflow-hidden">
      <div className="p-4 border-b border-white/[0.05] text-sm font-semibold flex items-center gap-2">
        <Activity className="w-4 h-4 text-neon-green animate-pulse" /> Live OTP Feed (last 50)
      </div>
      <table className="w-full text-xs">
        <thead className="bg-white/[0.03] text-muted-foreground uppercase tracking-wider">
          <tr>
            <th className="text-left py-2.5 px-4">When</th>
            <th className="text-left py-2.5 px-4">TG User</th>
            <th className="text-left py-2.5 px-4">Country</th>
            <th className="text-left py-2.5 px-4">Service / Range</th>
            <th className="text-left py-2.5 px-4">Number</th>
            <th className="text-left py-2.5 px-4">OTP</th>
            <th className="text-right py-2.5 px-4">Rate</th>
          </tr>
        </thead>
        <tbody>
          {feed.data?.rows.map(r => (
            <tr key={r.id} className="border-t border-white/[0.04]">
              <td className="py-2 px-4 text-muted-foreground">{fmtAgo(r.otp_received_at)}</td>
              <td className="py-2 px-4">{r.tg_username ? `@${r.tg_username}` : `id:${r.tg_user_id}`}</td>
              <td className="py-2 px-4">{flagOf(r.country_code)} <span className="text-muted-foreground">{r.country_code}</span></td>
              <td className="py-2 px-4">{serviceIcon(r.service)} {r.range_name}</td>
              <td className="py-2 px-4 font-mono text-neon-cyan">{r.phone_number}</td>
              <td className="py-2 px-4 font-mono text-neon-green font-bold">{r.otp_code}</td>
              <td className="py-2 px-4 text-right text-muted-foreground">{fmtBdt(r.rate_bdt)}</td>
            </tr>
          ))}
          {feed.data?.rows.length === 0 && (
            <tr><td colSpan={7} className="text-center py-8 text-muted-foreground">No OTPs delivered yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

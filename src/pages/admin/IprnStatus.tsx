import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { GradientMesh, PageHeader } from "@/components/premium";
import {
  Bot, CheckCircle2, XCircle, Activity, Database, MessageSquareText,
  RefreshCw, Power, Play, Square, Save, Eye, EyeOff, Zap, Layers,
  Clock, AlertTriangle, Sparkles, Cookie, Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type IprnStatusT = {
  enabled: boolean;
  running: boolean;
  loggedIn: boolean;
  lastLoginAt: number | null;
  lastScrapeAt: number | null;
  lastScrapeOk: boolean;
  lastNumbersScrapeAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  totalScrapes: number;
  numbersScrapedTotal: number;
  numbersAddedTotal: number;
  otpsDeliveredTotal: number;
  consecFail: number;
  baseUrl: string;
  otpIntervalSec: number;
  numbersIntervalSec: number;
  poolSize: number;
  claimingSize: number;
  activeAssigned: number;
  otpReceived: number;
  otpCacheSize: number;
  events?: { ts: number; level: string; message: string; meta: unknown }[];
};

const fmtAgo = (ts: number | null) => {
  if (!ts) return "never";
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const Pill = ({ ok, label }: { ok: boolean; label: string }) => (
  <span className={cn(
    "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold uppercase tracking-wide",
    ok ? "bg-neon-green/15 text-neon-green" : "bg-destructive/15 text-destructive"
  )}>
    {ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
    {label}
  </span>
);

const Stat = ({ icon, label, value, hint, accent }: {
  icon: React.ReactNode; label: string; value: string | number; hint?: string; accent?: string;
}) => (
  <div className="glass-card border border-white/[0.06] rounded-xl p-4">
    <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground mb-2">
      {icon}<span>{label}</span>
    </div>
    <div className={cn("text-2xl font-bold font-mono", accent || "text-foreground")}>{value}</div>
    {hint && <div className="text-xs text-muted-foreground mt-1">{hint}</div>}
  </div>
);

const Row = ({ label, value, mono, accent }: { label: string; value: string; mono?: boolean; accent?: string }) => (
  <div className="flex items-center justify-between gap-3">
    <span className="text-muted-foreground text-xs">{label}</span>
    <span className={cn("text-sm", mono && "font-mono", accent || "text-foreground")}>{value}</span>
  </div>
);

const CredentialsEditor = ({ onSaved }: { onSaved: () => void }) => {
  const [creds, setCreds] = useState({
    enabled: false, base_url: "", username: "", password: "", password_masked: "", has_password: false,
  });
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.iprn.credentials().then(d => setCreds(c => ({ ...c, ...d, password: "" }))).catch(() => {});
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.iprn.credentialsSave({
        username: creds.username || undefined,
        password: creds.password || undefined,
        base_url: creds.base_url || undefined,
        enabled: creds.enabled,
      });
      toast.success("IPRN credentials saved — bot restarting");
      setCreds(c => ({ ...c, password: "" }));
      onSaved();
    } catch (e) {
      toast.error("Save failed: " + (e as Error).message);
    } finally { setSaving(false); }
  };

  return (
    <div className="glass-card border border-white/[0.06] rounded-xl p-5 space-y-4">
      <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        <Layers className="w-3.5 h-3.5 text-neon-cyan" /> IPRN Credentials
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex items-center gap-2 text-xs text-muted-foreground sm:col-span-2">
          <input type="checkbox" checked={creds.enabled} onChange={e => setCreds(c => ({ ...c, enabled: e.target.checked }))} />
          Enable IPRN bot
        </label>
        <div>
          <div className="text-xs text-muted-foreground mb-1">Base URL</div>
          <input
            type="text" value={creds.base_url}
            onChange={e => setCreds(c => ({ ...c, base_url: e.target.value }))}
            placeholder="https://iprndata.com"
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-md px-3 py-2 text-sm font-mono"
          />
        </div>
        <div>
          <div className="text-xs text-muted-foreground mb-1">Username</div>
          <input
            type="text" value={creds.username}
            onChange={e => setCreds(c => ({ ...c, username: e.target.value }))}
            placeholder="MAMUN25"
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-md px-3 py-2 text-sm font-mono"
          />
        </div>
        <div className="sm:col-span-2">
          <div className="text-xs text-muted-foreground mb-1">
            Password {creds.has_password && <span className="text-neon-green">(saved: {creds.password_masked})</span>}
          </div>
          <div className="relative">
            <input
              type={showPw ? "text" : "password"} value={creds.password}
              onChange={e => setCreds(c => ({ ...c, password: e.target.value }))}
              placeholder={creds.has_password ? "Leave blank to keep current" : "Enter password"}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-md px-3 py-2 text-sm font-mono pr-10"
            />
            <button type="button" onClick={() => setShowPw(s => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
      <button
        onClick={handleSave} disabled={saving}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-neon-cyan/10 border border-neon-cyan/30 text-neon-cyan hover:bg-neon-cyan/20 transition disabled:opacity-50"
      >
        <Save className={cn("w-3.5 h-3.5", saving && "animate-pulse")} /> {saving ? "Saving…" : "Save & Restart Bot"}
      </button>
    </div>
  );
};

// Cookie session status — shows whether the bot has a saved upstream
// session and lets admin force-purge it. Cookie VALUES are never shown
// (they're live session tokens). Only count + saved-at timestamp.
const CookieSessionPanel = ({ onChanged }: { onChanged: () => void }) => {
  const [busy, setBusy] = useState(false);
  const { data, refetch } = useQuery({
    queryKey: ["iprn-cookies"],
    queryFn: () => api.iprn.cookies(),
    refetchInterval: 10000,
  });
  const has = !!data?.has_cookies;

  const clear = async () => {
    if (!confirm("Clear saved IPRN session and force a fresh login?")) return;
    setBusy(true);
    try {
      await api.iprn.cookiesClear();
      toast.success("Saved cookies cleared — bot restarting & re-logging in");
      await refetch();
      onChanged();
    } catch (e) { toast.error("Failed: " + (e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="glass-card border border-white/[0.06] rounded-xl p-5 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            <Cookie className="w-3.5 h-3.5 text-neon-magenta" /> Session Cookies
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            {has ? (
              <>
                <span className="text-neon-green">Saved session active</span> · {data?.count} cookies
                {data?.saved_at && <> · {fmtAgo(data.saved_at)}</>}
                <div className="text-[10px] text-muted-foreground/70 mt-0.5">
                  Bot resumes via cookies on restart — no CSRF re-login needed. If they expire, fresh login runs automatically.
                </div>
              </>
            ) : (
              <>No saved session — bot will perform a fresh login on next start.</>
            )}
          </div>
        </div>
        {has && (
          <button onClick={clear} disabled={busy}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-destructive/10 border border-destructive/30 text-destructive hover:bg-destructive/20 transition disabled:opacity-50">
            <Trash2 className="w-3.5 h-3.5" /> {busy ? "Clearing…" : "Clear & Re-login"}
          </button>
        )}
      </div>
    </div>
  );
};

const OtpIntervalSetting = ({ onSaved }: { onSaved: () => void }) => {
  const [saving, setSaving] = useState(false);
  const { data, refetch } = useQuery({
    queryKey: ["iprn-otp-interval"],
    queryFn: () => api.iprn.otpInterval(),
  });
  const current = data?.interval_sec ?? 4;
  const opts = data?.options ?? [2, 4, 10, 30];

  const save = async (sec: number) => {
    if (sec === current) return;
    setSaving(true);
    try {
      await api.iprn.otpIntervalSave(sec);
      toast.success(`OTP poll set to ${sec}s — bot restarting`);
      await refetch();
      onSaved();
    } catch (e) { toast.error("Failed: " + (e as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <div className="glass-card border border-white/[0.06] rounded-xl p-5 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            <Zap className="w-3.5 h-3.5 text-neon-yellow" /> OTP Poll Interval
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            How often the bot polls /sms-records for new OTPs. Lower = faster delivery (HTTP-only, very light).
            Current: <span className="font-mono text-neon-yellow">{current}s</span> <span className="text-muted-foreground/60">({data?.source})</span>
          </div>
        </div>
        <div className="flex gap-1.5">
          {opts.map(sec => (
            <button
              key={sec} onClick={() => save(sec)} disabled={saving}
              className={cn(
                "px-2.5 py-1.5 rounded-md text-xs font-semibold font-mono transition",
                sec === current
                  ? "bg-neon-yellow/20 border border-neon-yellow/40 text-neon-yellow"
                  : "bg-white/[0.04] border border-white/[0.08] text-muted-foreground hover:bg-white/[0.08]"
              )}
            >
              {sec}s
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default function IprnStatus() {
  const [busy, setBusy] = useState<string | null>(null);
  const { data, refetch, isLoading } = useQuery({
    queryKey: ["iprn-status"],
    queryFn: () => api.iprn.status(),
    refetchInterval: 5000,
  });

  const { data: pool, refetch: refetchPool } = useQuery({
    queryKey: ["iprn-pool"],
    queryFn: () => api.iprn.poolBreakdown(),
    refetchInterval: 10000,
  });

  const s = (data?.status as IprnStatusT) || ({} as IprnStatusT);

  const action = async (kind: "start" | "stop" | "restart" | "scrape") => {
    setBusy(kind);
    try {
      if (kind === "start") await api.iprn.start();
      if (kind === "stop") await api.iprn.stop();
      if (kind === "restart") await api.iprn.restart();
      if (kind === "scrape") {
        const r = await api.iprn.scrapeNow();
        if (r.error) toast.error(r.error);
        else toast.success(`Scrape OK · added ${r.added ?? 0}, OTPs ${r.otps ?? 0}`);
      } else {
        toast.success(`Bot ${kind} OK`);
      }
      await refetch();
      await refetchPool();
    } catch (e) {
      toast.error(`${kind} failed: ${(e as Error).message}`);
    } finally { setBusy(null); }
  };

  return (
    <div className="relative space-y-6 pb-12">
      <GradientMesh />

      <PageHeader
        eyebrow="Bot · IPRN Data"
        title="IPRN Bot Status"
        description="HTTP-only scraper for iprndata.com — ~10MB RAM, no captcha, no browser."
        icon={<Bot className="w-5 h-5" />}
        actions={
          <div className="flex flex-wrap gap-2">
            <button onClick={() => refetch()} disabled={isLoading}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] transition">
              <RefreshCw className={cn("w-3.5 h-3.5", isLoading && "animate-spin")} /> Refresh
            </button>
            <button onClick={() => action("scrape")} disabled={!!busy || !s.running}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-neon-cyan/10 border border-neon-cyan/30 text-neon-cyan hover:bg-neon-cyan/20 transition disabled:opacity-50">
              <Sparkles className={cn("w-3.5 h-3.5", busy === "scrape" && "animate-pulse")} /> Scrape Now
            </button>
            <button onClick={() => action("restart")} disabled={!!busy}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-neon-yellow/10 border border-neon-yellow/30 text-neon-yellow hover:bg-neon-yellow/20 transition disabled:opacity-50">
              <Power className={cn("w-3.5 h-3.5", busy === "restart" && "animate-spin")} /> Restart
            </button>
            {s.running ? (
              <button onClick={() => action("stop")} disabled={!!busy}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-destructive/10 border border-destructive/30 text-destructive hover:bg-destructive/20 transition disabled:opacity-50">
                <Square className="w-3.5 h-3.5" /> Stop
              </button>
            ) : (
              <button onClick={() => action("start")} disabled={!!busy}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-neon-green/10 border border-neon-green/30 text-neon-green hover:bg-neon-green/20 transition disabled:opacity-50">
                <Play className="w-3.5 h-3.5" /> Start
              </button>
            )}
          </div>
        }
      />

      {/* Status pills */}
      <div className="flex flex-wrap items-center gap-2">
        <Pill ok={s.enabled} label={s.enabled ? "Enabled" : "Disabled"} />
        <Pill ok={s.running} label={s.running ? "Running" : "Stopped"} />
        <Pill ok={s.loggedIn} label={s.loggedIn ? "Logged In" : "Logged Out"} />
        {s.lastError && (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-destructive/15 text-destructive">
            <AlertTriangle className="w-3.5 h-3.5" /> {s.lastError}
          </span>
        )}
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat icon={<Clock className="w-3.5 h-3.5 text-neon-cyan" />}
          label="Last Login" value={fmtAgo(s.lastLoginAt)} hint={s.loggedIn ? "session live" : "needs login"} />
        <Stat icon={<Activity className="w-3.5 h-3.5 text-neon-purple" />}
          label="Last Scrape" value={fmtAgo(s.lastScrapeAt)}
          hint={`every ${s.otpIntervalSec ?? 4}s · ${s.totalScrapes ?? 0} total`}
          accent={s.lastScrapeOk ? "text-foreground" : "text-destructive"} />
        <Stat icon={<Database className="w-3.5 h-3.5 text-neon-magenta" />}
          label="Pool Size" value={s.poolSize ?? 0}
          hint={`active assigned: ${s.activeAssigned ?? 0}`} accent="text-neon-magenta" />
        <Stat icon={<MessageSquareText className="w-3.5 h-3.5 text-neon-green" />}
          label="OTPs Delivered" value={s.otpsDeliveredTotal ?? 0}
          hint={`${s.otpReceived ?? 0} historical receipts`} accent="text-neon-green" />
      </div>

      {/* Config panel + range pool */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="glass-card border border-white/[0.06] rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground mb-1">
            <Sparkles className="w-3 h-3 text-neon-cyan" /> Configuration
          </div>
          <Row label="Base URL" value={s.baseUrl || "—"} mono accent="text-neon-cyan" />
          <Row label="OTP poll interval" value={`${s.otpIntervalSec ?? 4}s`} mono />
          <Row label="Number sync interval" value={`${s.numbersIntervalSec ?? 600}s`} mono />
          <Row label="Numbers scraped (total)" value={String(s.numbersScrapedTotal ?? 0)} mono />
          <Row label="Numbers added to pool" value={String(s.numbersAddedTotal ?? 0)} mono accent="text-neon-green" />
          <Row label="OTP cache size" value={String(s.otpCacheSize ?? 0)} mono />
          <Row label="Last numbers sync" value={fmtAgo(s.lastNumbersScrapeAt)} />
          <Row label="Consecutive failures" value={String(s.consecFail ?? 0)}
            accent={(s.consecFail ?? 0) > 0 ? "text-destructive" : "text-foreground"} />
        </div>

        <div className="space-y-3">
          <OtpIntervalSetting onSaved={() => refetch()} />
          <CookieSessionPanel onChanged={() => refetch()} />
          <CredentialsEditor onSaved={() => refetch()} />
        </div>
      </div>

      {/* Range pool grid */}
      {pool && pool.ranges.length > 0 && (
        <div className="glass-card border border-white/[0.06] rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
              <Database className="w-3 h-3 text-neon-magenta" /> Pool by Range
            </div>
            <div className="flex gap-3 text-[10px] uppercase tracking-wider text-muted-foreground">
              <span>Active: <span className="font-mono text-neon-cyan">{pool.totalActive}</span></span>
              <span>Used: <span className="font-mono text-neon-green">{pool.totalUsed}</span></span>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {pool.ranges.map(r => (
              <div key={r.name} className={cn(
                "rounded-lg border px-3 py-2 flex items-center justify-between gap-2",
                r.disabled ? "border-destructive/30 bg-destructive/5 opacity-60" : "border-white/[0.06] bg-white/[0.02]"
              )}>
                <div className="min-w-0">
                  <div className="text-xs font-mono truncate text-foreground">{r.custom_name || r.name}</div>
                  <div className="text-[10px] text-muted-foreground">{r.last_added ? fmtAgo(r.last_added) : "—"}</div>
                </div>
                <span className="text-sm font-bold font-mono text-neon-magenta shrink-0">{r.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent events */}
      {s.events && s.events.length > 0 && (
        <div className="glass-card border border-white/[0.06] rounded-xl p-5">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground mb-3">
            <Activity className="w-3 h-3 text-neon-purple" /> Recent Events
          </div>
          <div className="space-y-1 font-mono text-xs max-h-64 overflow-y-auto">
            {s.events.slice().reverse().map((ev, i) => (
              <div key={i} className="flex gap-2">
                <span className="text-muted-foreground/60 shrink-0">{fmtAgo(ev.ts)}</span>
                <span className={cn("shrink-0 uppercase",
                  ev.level === "error" ? "text-destructive" :
                  ev.level === "warn" ? "text-neon-yellow" :
                  ev.level === "success" ? "text-neon-green" : "text-muted-foreground"
                )}>{ev.level}</span>
                <span className="text-foreground/80">{ev.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { GradientMesh, PageHeader } from "@/components/premium";
import {
  Bot, CheckCircle2, XCircle, Activity, Database, MessageSquareText,
  RefreshCw, Power, Play, Square, Save, Eye, EyeOff, Zap, Sparkles, Layers,
  Clock, ClipboardPaste, Plus, Info, AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type MsiStatus = {
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
  emptyStreak?: number;
  emptyLimit?: number;
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
  const [creds, setCreds] = useState<{ enabled: boolean; base_url: string; username: string; password: string; password_masked: string; has_password: boolean }>({
    enabled: false, base_url: "", username: "", password: "", password_masked: "", has_password: false,
  });
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.admin.msiCredentials().then(d => setCreds(c => ({ ...c, ...d, password: "" }))).catch(() => {});
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.admin.msiCredentialsSave({
        username: creds.username || undefined,
        password: creds.password || undefined,
        base_url: creds.base_url || undefined,
        enabled: creds.enabled,
      });
      toast.success("MSI credentials saved — bot restarting");
      setCreds(c => ({ ...c, password: "" }));
      onSaved();
    } catch (e) {
      toast.error("Save failed: " + (e as Error).message);
    } finally { setSaving(false); }
  };

  return (
    <div className="glass-card border border-white/[0.06] rounded-xl p-5 space-y-4">
      <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        <Layers className="w-3.5 h-3.5 text-neon-cyan" /> MSI Credentials
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex items-center gap-2 text-xs text-muted-foreground sm:col-span-2">
          <input type="checkbox" checked={creds.enabled} onChange={e => setCreds(c => ({ ...c, enabled: e.target.checked }))} />
          Enable MSI bot
        </label>
        <div>
          <div className="text-xs text-muted-foreground mb-1">Base URL</div>
          <input
            type="text" value={creds.base_url}
            onChange={e => setCreds(c => ({ ...c, base_url: e.target.value }))}
            placeholder="http://145.239.130.45"
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-md px-3 py-2 text-sm font-mono"
          />
        </div>
        <div>
          <div className="text-xs text-muted-foreground mb-1">Username</div>
          <input
            type="text" value={creds.username}
            onChange={e => setCreds(c => ({ ...c, username: e.target.value }))}
            placeholder="Ashik07"
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

// ---- OTP poll interval setting ----
const MsiOtpIntervalSetting = ({ onSaved }: { onSaved: () => void }) => {
  const [saving, setSaving] = useState(false);
  const { data, refetch, isLoading } = useQuery({
    queryKey: ["msi-otp-interval"],
    queryFn: () => api.admin.msiOtpInterval(),
  });
  const current = data?.interval_sec ?? 5;
  const opts = data?.options ?? [3, 5, 10, 30];

  const save = async (sec: number) => {
    if (sec === current) return;
    setSaving(true);
    try {
      await api.admin.msiOtpIntervalSave(sec);
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
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Clock className="w-4 h-4 text-neon-cyan" /> OTP Poll Interval
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            How often the bot scrapes the MSI CDR page for new OTPs. Lower = faster delivery, more CPU.
            {data && (
              <span className="ml-2 font-mono">
                Current: <span className="text-neon-cyan font-semibold">{current}s</span>
                <span className="text-muted-foreground/60"> ({data.source})</span>
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {opts.map(v => (
            <button key={v} onClick={() => save(v)} disabled={saving || isLoading}
              className={cn(
                "px-4 py-2 rounded-md text-xs font-semibold border transition disabled:opacity-50",
                v === current
                  ? "bg-neon-cyan/15 border-neon-cyan/40 text-neon-cyan"
                  : "bg-white/[0.04] border-white/[0.08] text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
              )}>
              {v}s
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

// ---- Manual paste-numbers (mirror IMS) ----
const MsiManualPaste = ({ existingRanges, onAdded }: { existingRanges: string[]; onAdded: () => void }) => {
  const [open, setOpen] = useState(false);
  const [rangeMode, setRangeMode] = useState<"existing" | "new">("existing");
  const [selectedRange, setSelectedRange] = useState("");
  const [newRange, setNewRange] = useState("");
  const [countryCode, setCountryCode] = useState("");
  const [raw, setRaw] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const parsed = raw
    .split(/[\s,;\n\r\t]+/)
    .map(s => s.replace(/[^\d+]/g, "").replace(/^\++/, "+"))
    .filter(s => s.replace(/\D/g, "").length >= 6);
  const uniqueCount = new Set(parsed).size;

  const submit = async () => {
    const range = (rangeMode === "existing" ? selectedRange : newRange).trim();
    if (!range) { toast.error("Range name required"); return; }
    if (!parsed.length) { toast.error("Paste at least one valid number"); return; }
    setSubmitting(true);
    try {
      const r = await api.msiAddPool({
        numbers: Array.from(new Set(parsed)),
        range,
        country_code: countryCode.trim() || undefined,
      });
      toast.success(`Added ${r.added} numbers to "${r.range}"` +
        (r.skipped ? ` · ${r.skipped} dup` : "") +
        (r.invalid ? ` · ${r.invalid} invalid` : ""));
      setRaw(""); setNewRange(""); setSelectedRange(""); setCountryCode("");
      onAdded();
    } catch (e) { toast.error("Add failed: " + (e as Error).message); }
    finally { setSubmitting(false); }
  };

  return (
    <div className="glass-card border border-white/[0.06] rounded-xl overflow-hidden">
      <button onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between p-4 hover:bg-white/[0.02] transition">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-neon-magenta/10 border border-neon-magenta/20 flex items-center justify-center">
            <ClipboardPaste className="w-4 h-4 text-neon-magenta" />
          </div>
          <div className="text-left">
            <div className="text-sm font-semibold">Manual Paste — Add Numbers to MSI Pool</div>
            <div className="text-xs text-muted-foreground">
              Paste copied numbers from MSI panel, pick a range, instantly available to agents
            </div>
          </div>
        </div>
        <span className="text-xs text-muted-foreground">{open ? "Hide" : "Open"}</span>
      </button>

      {open && (
        <div className="border-t border-white/[0.06] p-5 space-y-4 bg-black/20">
          <p className="text-xs text-muted-foreground flex items-start gap-2">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-neon-magenta" />
            Numbers are deduplicated against the current pool. Range name is what agents see in the dropdown.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground">Range</label>
              <div className="flex gap-1 my-1.5">
                <button type="button" onClick={() => setRangeMode("existing")} disabled={!existingRanges.length}
                  className={cn("px-3 py-1 rounded text-xs font-semibold transition border",
                    rangeMode === "existing"
                      ? "bg-neon-magenta/15 border-neon-magenta/40 text-neon-magenta"
                      : "bg-white/[0.03] border-white/[0.08] text-muted-foreground hover:text-foreground")}>
                  Existing
                </button>
                <button type="button" onClick={() => setRangeMode("new")}
                  className={cn("px-3 py-1 rounded text-xs font-semibold transition border inline-flex items-center gap-1",
                    rangeMode === "new"
                      ? "bg-neon-magenta/15 border-neon-magenta/40 text-neon-magenta"
                      : "bg-white/[0.03] border-white/[0.08] text-muted-foreground hover:text-foreground")}>
                  <Plus className="w-3 h-3" /> New
                </button>
              </div>
              {rangeMode === "existing" ? (
                <select value={selectedRange} onChange={e => setSelectedRange(e.target.value)}
                  className="w-full bg-black/40 border border-white/[0.08] rounded-md px-3 py-2 text-sm focus:border-neon-magenta/50 outline-none">
                  <option value="">— select existing range —</option>
                  {existingRanges.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              ) : (
                <input value={newRange} onChange={e => setNewRange(e.target.value)}
                  placeholder="e.g. India Airtel TF01"
                  className="w-full bg-black/40 border border-white/[0.08] rounded-md px-3 py-2 text-sm font-mono focus:border-neon-magenta/50 outline-none" />
              )}
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground">Country Code (optional)</label>
              <input value={countryCode} onChange={e => setCountryCode(e.target.value.toUpperCase())} maxLength={4}
                placeholder="IN"
                className="mt-1.5 w-full bg-black/40 border border-white/[0.08] rounded-md px-3 py-2 text-sm font-mono uppercase focus:border-neon-magenta/50 outline-none" />
            </div>
          </div>
          <div>
            <label className="text-xs uppercase tracking-wider text-muted-foreground">
              Numbers — paste one per line, comma, or space ({uniqueCount} unique detected)
            </label>
            <textarea value={raw} onChange={e => setRaw(e.target.value)} rows={8} spellCheck={false}
              placeholder={"+919876543210\n+919876543211\n..."}
              className="mt-1.5 w-full bg-black/40 border border-white/[0.08] rounded-md px-3 py-2 text-sm font-mono focus:border-neon-magenta/50 outline-none resize-y" />
          </div>
          <div className="flex justify-end">
            <button onClick={submit} disabled={submitting || !uniqueCount}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-xs font-semibold bg-neon-magenta/10 border border-neon-magenta/30 text-neon-magenta hover:bg-neon-magenta/20 transition disabled:opacity-50">
              <Plus className={cn("w-3.5 h-3.5", submitting && "animate-pulse")} />
              {submitting ? "Adding…" : `Add ${uniqueCount || ""} to pool`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

const AdminMsiStatus = () => {
  const [restarting, setRestarting] = useState(false);
  const [scraping, setScraping] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["msi-status"],
    queryFn: () => api.admin.msiStatus(),
    refetchInterval: 5000,
  });
  const { data: poolData, refetch: refetchPool } = useQuery({
    queryKey: ["msi-pool-breakdown"],
    queryFn: () => api.admin.msiPoolBreakdown(),
    refetchInterval: 10000,
  });
  const s = data?.status as MsiStatus | undefined;

  const handleAction = async (action: "restart" | "start" | "stop") => {
    const labels = { restart: "Restart", start: "Start", stop: "Stop" };
    if (action === "stop" && !confirm("Stop the MSI bot?")) return;
    if (action === "restart" && !confirm("Restart the MSI bot?")) return;
    setRestarting(true);
    try {
      if (action === "restart") await api.admin.msiRestart();
      else if (action === "start") await api.admin.msiStart();
      else await api.admin.msiStop();
      toast.success(`${labels[action]} initiated`);
      setTimeout(() => refetch(), 1500);
    } catch (e) {
      toast.error(`${labels[action]} failed: ` + (e as Error).message);
    } finally { setRestarting(false); }
  };

  const handleScrapeNow = async () => {
    setScraping(true);
    try {
      const r = await api.admin.msiScrapeNow();
      if (r.ok) toast.success(`Scrape complete — ${r.otps ?? 0} OTPs delivered`);
      else toast.error(r.error || "Scrape failed");
      refetch(); refetchPool();
    } catch (e) {
      toast.error("Scrape failed: " + (e as Error).message);
    } finally { setScraping(false); }
  };

  const handleSyncLive = async () => {
    if (!confirm(
      "Live Sync will:\n" +
      "  • ADD any new MSI numbers\n" +
      "  • REMOVE pool numbers MSI no longer has\n" +
      "  • Active assigned numbers are NEVER touched\n\nContinue?"
    )) return;
    setSyncing(true);
    try {
      const r = await api.admin.msiSyncLive();
      if (r.ok) {
        toast.success(`Live sync done: +${r.added ?? 0} added · -${r.removed ?? 0} removed · ${r.kept ?? 0} kept (${r.scraped ?? 0} live)`, { duration: 6000 });
      } else { toast.error(r.error || "Live sync failed"); }
      refetch(); refetchPool();
    } catch (e) {
      toast.error("Live sync failed: " + (e as Error).message);
    } finally { setSyncing(false); }
  };

  return (
    <div className="relative space-y-6">
      <GradientMesh variant="default" />
      <PageHeader
        eyebrow="Workers"
        title="MSI Bot Status"
        description="Headless browser scraper for 145.239.130.45 — fast OTP delivery, no rate limits"
        icon={<Bot className="w-5 h-5 text-neon-cyan" />}
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            {s?.running ? (
              <button onClick={() => handleAction("stop")} disabled={restarting}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-destructive/10 border border-destructive/30 text-destructive hover:bg-destructive/20 transition disabled:opacity-50">
                <Square className="w-3.5 h-3.5" /> Stop
              </button>
            ) : (
              <button onClick={() => handleAction("start")} disabled={restarting}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-neon-green/10 border border-neon-green/30 text-neon-green hover:bg-neon-green/20 transition disabled:opacity-50">
                <Play className="w-3.5 h-3.5" /> Start
              </button>
            )}
            <button onClick={handleScrapeNow} disabled={scraping || !s?.running}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-neon-cyan/10 border border-neon-cyan/30 text-neon-cyan hover:bg-neon-cyan/20 transition disabled:opacity-50">
              <Zap className={cn("w-3.5 h-3.5", scraping && "animate-pulse")} />
              {scraping ? "Scraping…" : "Scrape Now"}
            </button>
            <button onClick={handleSyncLive} disabled={syncing || !s?.running}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-neon-amber/10 border border-neon-amber/30 text-neon-amber hover:bg-neon-amber/20 transition disabled:opacity-50">
              <Sparkles className={cn("w-3.5 h-3.5", syncing && "animate-pulse")} />
              {syncing ? "Syncing…" : "Sync Live"}
            </button>
            <button onClick={() => handleAction("restart")} disabled={restarting}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-neon-magenta/10 border border-neon-magenta/30 text-neon-magenta hover:bg-neon-magenta/20 transition disabled:opacity-50">
              <Power className={cn("w-3.5 h-3.5", restarting && "animate-spin")} /> {restarting ? "Working…" : "Restart"}
            </button>
            <button onClick={() => { refetch(); refetchPool(); }}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] transition">
              <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} /> Refresh
            </button>
          </div>
        }
      />

      {isLoading && <p className="text-center text-muted-foreground text-sm">Loading…</p>}

      {s && (
        <>
          <div className="flex flex-wrap gap-2">
            <Pill ok={s.enabled} label={s.enabled ? "Enabled" : "Disabled"} />
            <Pill ok={s.running} label={s.running ? "Running" : "Stopped"} />
            <Pill ok={s.loggedIn} label={s.loggedIn ? "Logged in" : "Not logged in"} />
            <Pill ok={s.lastScrapeOk} label={s.lastScrapeOk ? "Last scrape OK" : "Last scrape failed"} />
          </div>

          <CredentialsEditor onSaved={() => refetch()} />

          <MsiOtpIntervalSetting onSaved={() => refetch()} />

          <MsiManualPaste
            existingRanges={poolData?.ranges?.map(r => r.name) ?? []}
            onAdded={() => { refetch(); refetchPool(); }}
          />

          {(s.emptyLimit ?? 0) > 0 && (
            <div className="glass-card border border-white/[0.06] rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-neon-amber" /> Auto-pause guard
                </span>
                <span className="text-xs font-mono text-muted-foreground">
                  {s.emptyStreak ?? 0} / {s.emptyLimit} empty scrapes
                </span>
              </div>
              <div className="h-2 bg-white/[0.04] rounded-full overflow-hidden">
                <div
                  className={cn("h-full transition-all duration-500",
                    (s.emptyStreak ?? 0) >= (s.emptyLimit ?? 10) * 0.7 ? "bg-destructive" :
                    (s.emptyStreak ?? 0) >= (s.emptyLimit ?? 10) * 0.4 ? "bg-neon-amber" : "bg-neon-green"
                  )}
                  style={{ width: `${Math.min(100, ((s.emptyStreak ?? 0) / (s.emptyLimit ?? 10)) * 100)}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Bot will auto-stop if {s.emptyLimit} consecutive scrapes return zero numbers (set MSI_EMPTY_LIMIT env to enable; 0 = disabled).
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat icon={<CheckCircle2 className="w-3.5 h-3.5" />} label="Last login" value={fmtAgo(s.lastLoginAt)}
              hint={s.lastLoginAt ? new Date(s.lastLoginAt * 1000).toLocaleString() : "—"}
              accent="text-neon-cyan" />
            <Stat icon={<Activity className="w-3.5 h-3.5" />} label="Last scrape" value={fmtAgo(s.lastScrapeAt)}
              hint={`every ${s.otpIntervalSec}s · ${s.totalScrapes} total`}
              accent={s.lastScrapeOk ? "text-neon-green" : "text-destructive"} />
            <Stat icon={<Database className="w-3.5 h-3.5" />} label="Pool size" value={s.poolSize}
              hint={`active assigned: ${s.activeAssigned}`}
              accent="text-neon-magenta" />
            <Stat icon={<MessageSquareText className="w-3.5 h-3.5" />} label="OTPs delivered" value={s.otpsDeliveredTotal}
              hint={`${s.otpReceived} historical receipts`}
              accent="text-neon-green" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="glass-card border border-white/[0.06] rounded-xl p-5 space-y-3">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Configuration</h3>
              <div className="space-y-2 text-sm">
                <Row label="Base URL" value={s.baseUrl || "—"} mono />
                <Row label="OTP poll interval" value={`${s.otpIntervalSec}s`} mono accent="text-neon-cyan" />
                <Row label="Number sync interval" value={`${s.numbersIntervalSec}s`} mono />
                <Row label="Numbers scraped (total)" value={String(s.numbersScrapedTotal)} mono />
                <Row label="Numbers added to pool" value={String(s.numbersAddedTotal)} mono accent="text-neon-cyan" />
                <Row label="OTP cache size" value={String(s.otpCacheSize)} mono />
                <Row label="Last numbers sync" value={fmtAgo(s.lastNumbersScrapeAt)} mono />
                <Row label="Consecutive failures" value={String(s.consecFail)} mono accent={s.consecFail > 0 ? "text-destructive" : undefined} />
              </div>
            </div>

            <div className="glass-card border border-white/[0.06] rounded-xl p-5 space-y-3">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Pool by Range</h3>
              {poolData?.ranges?.length ? (
                <div className="space-y-1.5 max-h-64 overflow-y-auto scrollbar-none pr-1">
                  {poolData.ranges.map(r => (
                    <div key={r.name} className="flex items-center justify-between text-sm py-1 border-b border-white/[0.04]">
                      <span className="font-mono text-xs text-muted-foreground truncate">{r.name}</span>
                      <span className="font-mono font-bold text-neon-cyan">{r.count}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground italic">Pool empty — start the bot or run Sync Live</p>
              )}
            </div>
          </div>

          {s.lastError && (
            <div className="glass-card border border-destructive/30 bg-destructive/5 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-1">
                <XCircle className="w-4 h-4 text-destructive" />
                <span className="text-xs font-semibold uppercase tracking-wider text-destructive">Last Error</span>
                <span className="text-xs text-muted-foreground">{fmtAgo(s.lastErrorAt)}</span>
              </div>
              <p className="text-sm font-mono text-destructive/90">{s.lastError}</p>
            </div>
          )}

          <div className="glass-card border border-white/[0.06] rounded-xl p-5">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">Recent Activity</h3>
            {s.events?.length ? (
              <div className="space-y-1.5 max-h-80 overflow-y-auto scrollbar-none">
                {s.events.map((e, i) => (
                  <div key={i} className="flex items-start gap-3 text-xs py-1.5 border-b border-white/[0.04]">
                    <span className="font-mono text-muted-foreground whitespace-nowrap">{fmtAgo(e.ts)}</span>
                    <span className={cn("font-semibold uppercase",
                      e.level === "success" && "text-neon-green",
                      e.level === "error" && "text-destructive",
                      e.level === "warn" && "text-neon-amber",
                      e.level === "info" && "text-neon-cyan",
                    )}>{e.level}</span>
                    <span className="text-foreground/80 flex-1">{e.message}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic">No events yet</p>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default AdminMsiStatus;

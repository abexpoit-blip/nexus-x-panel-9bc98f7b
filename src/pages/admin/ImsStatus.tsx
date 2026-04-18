import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { GradientMesh, PageHeader } from "@/components/premium";
import { Bot, CheckCircle2, XCircle, Activity, Database, MessageSquareText, AlertTriangle, RefreshCw, Power, Info, Play, Square, KeyRound, Save, Eye, EyeOff, Zap, Layers, ClipboardPaste, Plus, Trash2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type ImsStatus = {
  enabled: boolean;
  running: boolean;
  loggedIn: boolean;
  lastLoginAt: number | null;
  lastScrapeAt: number | null;
  lastScrapeOk: boolean;
  lastError: string | null;
  lastErrorAt: number | null;
  totalScrapes: number;
  numbersScrapedTotal: number;
  numbersAddedTotal: number;
  otpsDeliveredTotal: number;
  consecFail: number;
  baseUrl: string;
  intervalSec: number;
  poolSize: number;
  activeAssigned: number;
  otpReceived: number;
  emptyStreak?: number;
  emptyLimit?: number;
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
  <span className={cn("inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold uppercase tracking-wide",
    ok ? "bg-neon-green/15 text-neon-green" : "bg-destructive/15 text-destructive")}>
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

const AdminImsStatus = () => {
  const [restarting, setRestarting] = useState(false);
  const [scraping, setScraping] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [bgStarting, setBgStarting] = useState(false);
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["ims-status"],
    queryFn: () => api.admin.imsStatus(),
    refetchInterval: 5000,
  });
  const { data: poolData, refetch: refetchPool } = useQuery({
    queryKey: ["ims-pool-breakdown"],
    queryFn: () => api.admin.imsPoolBreakdown(),
    refetchInterval: 10000,
  });
  // Poll background numbers job — fast (2s) when running, slow (15s) when idle
  const { data: numbersJob } = useQuery({
    queryKey: ["ims-numbers-job"],
    queryFn: () => api.admin.imsNumbersJob(),
    refetchInterval: (q) => (q.state.data?.status === "running" ? 2000 : 15000),
  });
  const s = data?.status as ImsStatus | undefined;
  const jobRunning = numbersJob?.status === "running";

  const handleAction = async (action: "restart" | "start" | "stop") => {
    const labels = { restart: "Restart", start: "Start", stop: "Stop" };
    if (action === "stop" && !confirm("Stop the IMS bot? It will stop scraping until restarted.")) return;
    if (action === "restart" && !confirm("Restart the IMS bot? Current scrape will be interrupted.")) return;
    setRestarting(true);
    try {
      if (action === "restart") await api.admin.imsRestart();
      else if (action === "start") await api.admin.imsStart();
      else await api.admin.imsStop();
      toast.success(`${labels[action]} initiated`);
      setTimeout(() => refetch(), 1500);
    } catch (e) {
      toast.error(`${labels[action]} failed: ` + (e as Error).message);
    } finally {
      setRestarting(false);
    }
  };

  const handleScrapeNow = async () => {
    setScraping(true);
    try {
      const r = await api.admin.imsScrapeNow();
      if (r.ok) {
        toast.success(`Scrape complete: +${r.added ?? 0} numbers, ${r.otps ?? 0} OTPs delivered`);
      } else {
        toast.error(r.error || "Scrape failed");
      }
      refetch(); refetchPool();
    } catch (e) {
      toast.error("Scrape failed: " + (e as Error).message);
    } finally {
      setScraping(false);
    }
  };

  const handleSyncLive = async () => {
    if (!confirm(
      "Live Sync will:\n" +
      "  • ADD any new numbers IMS has\n" +
      "  • REMOVE pool numbers that are NO LONGER in IMS\n" +
      "  • Active assigned numbers are NEVER touched\n\n" +
      "Continue?"
    )) return;
    setSyncing(true);
    try {
      const r = await api.admin.imsSyncLive();
      if (r.ok) {
        toast.success(
          `Live sync done: +${r.added ?? 0} added · -${r.removed ?? 0} removed · ${r.kept ?? 0} kept (${r.scraped ?? 0} live in IMS)`,
          { duration: 6000 }
        );
      } else {
        toast.error(r.error || "Live sync failed");
      }
      refetch(); refetchPool();
    } catch (e) {
      toast.error("Live sync failed: " + (e as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  const handleScrapeNumbersBg = async () => {
    setBgStarting(true);
    try {
      const r = await api.admin.imsScrapeNumbersStart();
      if (r.ok) {
        toast.success("Background numbers scrape started — progress shown below", { duration: 4000 });
      } else {
        toast.error(r.error || "Failed to start background scrape");
      }
    } catch (e) {
      toast.error("Failed: " + (e as Error).message);
    } finally {
      setBgStarting(false);
    }
  };

  return (
    <div className="relative space-y-6">
      <GradientMesh variant="default" />
      <PageHeader
        eyebrow="Workers"
        title="IMS Bot Status"
        description="Headless browser scraper running on the VPS — live numbers + OTP delivery"
        icon={<Bot className="w-5 h-5 text-neon-magenta" />}
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            {s?.running ? (
              <button
                onClick={() => handleAction("stop")}
                disabled={restarting}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-destructive/10 border border-destructive/30 text-destructive hover:bg-destructive/20 transition disabled:opacity-50"
              >
                <Square className="w-3.5 h-3.5" /> Stop
              </button>
            ) : (
              <button
                onClick={() => handleAction("start")}
                disabled={restarting}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-neon-green/10 border border-neon-green/30 text-neon-green hover:bg-neon-green/20 transition disabled:opacity-50"
              >
                <Play className="w-3.5 h-3.5" /> Start
              </button>
            )}
            <button
              onClick={handleScrapeNow}
              disabled={scraping || !s?.running}
              title={!s?.running ? "Start the bot first" : "Run a scrape cycle right now"}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-neon-cyan/10 border border-neon-cyan/30 text-neon-cyan hover:bg-neon-cyan/20 transition disabled:opacity-50"
            >
              <Zap className={cn("w-3.5 h-3.5", scraping && "animate-pulse")} />
              {scraping ? "Scraping…" : "Scrape Now"}
            </button>
            <button
              onClick={handleSyncLive}
              disabled={syncing || !s?.running}
              title={!s?.running ? "Start the bot first" : "Add new numbers + remove pool numbers IMS no longer has"}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-neon-amber/10 border border-neon-amber/30 text-neon-amber hover:bg-neon-amber/20 transition disabled:opacity-50"
            >
              <Sparkles className={cn("w-3.5 h-3.5", syncing && "animate-pulse")} />
              {syncing ? "Syncing…" : "Sync Live"}
            </button>
            <button
              onClick={handleScrapeNumbersBg}
              disabled={bgStarting || jobRunning || !s?.running}
              title={!s?.running ? "Start the bot first" : "Scrape numbers + ranges in background (non-blocking)"}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-neon-purple/10 border border-neon-purple/30 text-neon-purple hover:bg-neon-purple/20 transition disabled:opacity-50"
            >
              <Database className={cn("w-3.5 h-3.5", (bgStarting || jobRunning) && "animate-pulse")} />
              {jobRunning ? "Scraping in BG…" : bgStarting ? "Starting…" : "Scrape Numbers (BG)"}
            </button>
            <button
              onClick={() => handleAction("restart")}
              disabled={restarting}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-neon-magenta/10 border border-neon-magenta/30 text-neon-magenta hover:bg-neon-magenta/20 transition disabled:opacity-50"
            >
              <Power className={cn("w-3.5 h-3.5", restarting && "animate-spin")} /> {restarting ? "Working…" : "Restart"}
            </button>
            <button
              onClick={() => { refetch(); refetchPool(); }}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] transition"
            >
              <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} /> Refresh
            </button>
          </div>
        }
      />

      {isLoading && <p className="text-center text-muted-foreground text-sm">Loading…</p>}

      {s && (
        <>
          {/* Status pills */}
          <div className="flex flex-wrap gap-2">
            <Pill ok={s.enabled} label={s.enabled ? "Enabled" : "Disabled"} />
            <Pill ok={s.running} label={s.running ? "Running" : "Stopped"} />
            <Pill ok={s.loggedIn} label={s.loggedIn ? "Logged in" : "Not logged in"} />
            <Pill ok={s.lastScrapeOk} label={s.lastScrapeOk ? "Last scrape OK" : "Last scrape failed"} />
          </div>

          {/* Credentials editor */}
          <CredentialsEditor onSaved={() => refetch()} />

          {/* OTP poll interval setting */}
          <OtpIntervalSetting onSaved={() => refetch()} />

          {/* OTP expiry window (5-30 min) — applies to ALL providers */}
          <OtpExpirySetting onSaved={() => refetch()} />

          {/* Recent OTP visibility window — controls how long received OTPs
              stay on the agent's "live" Get Number / My Numbers list before
              moving into their permanent OTP History page. */}
          <RecentOtpWindowSetting onSaved={() => refetch()} />

          {/* Manual paste-numbers */}
          <ManualPastePool
            existingRanges={poolData?.ranges?.map(r => r.name) ?? []}
            onAdded={() => { refetch(); refetchPool(); }}
          />

          {/* Auto-pause meter */}
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
                Bot will auto-stop and notify admins if {s.emptyLimit} consecutive scrapes return zero numbers (saves VPS resources when IMS has no stock).
              </p>
            </div>
          )}

          {/* Stats grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat icon={<CheckCircle2 className="w-3.5 h-3.5" />} label="Last login" value={fmtAgo(s.lastLoginAt)}
              hint={s.lastLoginAt ? new Date(s.lastLoginAt * 1000).toLocaleString() : "—"}
              accent="text-neon-cyan" />
            <Stat icon={<Activity className="w-3.5 h-3.5" />} label="Last scrape" value={fmtAgo(s.lastScrapeAt)}
              hint={`every ${s.intervalSec}s · ${s.totalScrapes} total`}
              accent={s.lastScrapeOk ? "text-neon-green" : "text-destructive"} />
            <Stat icon={<Database className="w-3.5 h-3.5" />} label="Pool size" value={s.poolSize}
              hint={`active assigned: ${s.activeAssigned}`}
              accent="text-neon-magenta" />
            <Stat icon={<MessageSquareText className="w-3.5 h-3.5" />} label="OTPs delivered" value={s.otpsDeliveredTotal}
              hint={`${s.otpReceived} historical receipts`}
              accent="text-neon-green" />
          </div>

          {/* Secondary info */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="glass-card border border-white/[0.06] rounded-xl p-5 space-y-3">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Configuration</h3>
              <div className="space-y-2 text-sm">
                <Row label="Base URL" value={s.baseUrl || "—"} mono />
                <Row label="Scrape interval" value={`${s.intervalSec}s`} mono />
                <Row label="Numbers scraped (sessions total)" value={String(s.numbersScrapedTotal)} mono />
                <Row label="Numbers added to pool" value={String(s.numbersAddedTotal)} mono accent="text-neon-cyan" />
                <Row label="Consecutive failures" value={String(s.consecFail)} mono accent={s.consecFail > 0 ? "text-destructive" : undefined} />
              </div>
            </div>

            <div className="glass-card border border-white/[0.06] rounded-xl p-5 space-y-3">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-neon-amber" /> Last error
              </h3>
              {s.lastError ? (
                <>
                  <p className="text-xs text-muted-foreground">{fmtAgo(s.lastErrorAt)}</p>
                  <pre className="text-xs font-mono bg-black/40 border border-destructive/20 rounded p-3 whitespace-pre-wrap break-words text-destructive/90">
                    {s.lastError}
                  </pre>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">No errors recorded ✓</p>
              )}
            </div>
          </div>

          {/* Pool cleanup tools */}
          <PoolCleanup
            ranges={poolData?.ranges?.map(r => r.name) ?? []}
            onCleaned={() => { refetch(); refetchPool(); }}
          />

          {/* Pool breakdown by range */}
          <div className="glass-card border border-white/[0.06] rounded-xl p-5 space-y-3">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <Layers className="w-4 h-4 text-neon-magenta" /> Pool by Range
              <span className="text-xs text-muted-foreground/60 normal-case font-normal">
                (live count of unassigned numbers per IMS range)
              </span>
            </h3>
            {!poolData || poolData.ranges.length === 0 ? (
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <Info className="w-4 h-4" /> No numbers in pool. Click <strong>Scrape Now</strong> or wait for the auto-scrape cycle.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs uppercase tracking-wider text-muted-foreground border-b border-white/[0.06]">
                      <th className="text-left py-2 font-medium">Range</th>
                      <th className="text-right py-2 font-medium">Available</th>
                      <th className="text-right py-2 font-medium">Last Refilled</th>
                    </tr>
                  </thead>
                  <tbody>
                    {poolData.ranges.map((r) => (
                      <tr key={r.name} className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02]">
                        <td className="py-2 font-medium text-foreground">{r.name}</td>
                        <td className="py-2 text-right">
                          <span className={cn(
                            "inline-block px-2 py-0.5 rounded font-mono text-xs font-semibold",
                            r.count > 50 ? "bg-neon-green/15 text-neon-green" :
                            r.count > 10 ? "bg-neon-amber/15 text-neon-amber" :
                            "bg-destructive/15 text-destructive"
                          )}>
                            {r.count}
                          </span>
                        </td>
                        <td className="py-2 text-right text-xs text-muted-foreground font-mono">{fmtAgo(r.last_added)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-white/[0.08] text-xs">
                      <td className="py-2 font-semibold text-muted-foreground uppercase tracking-wider">Total</td>
                      <td className="py-2 text-right font-mono font-bold text-neon-cyan">
                        {poolData.ranges.reduce((s, r) => s + r.count, 0)}
                      </td>
                      <td className="py-2 text-right text-muted-foreground">
                        {poolData.totalActive} assigned to agents
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>

          {/* Activity log */}
          <div className="glass-card border border-white/[0.06] rounded-xl p-5 space-y-3">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <Activity className="w-4 h-4 text-neon-cyan" /> Recent activity
              <span className="text-xs text-muted-foreground/60 normal-case font-normal">(last 20 events)</span>
            </h3>
            {s.events && s.events.length > 0 ? (
              <div className="space-y-1 max-h-80 overflow-y-auto">
                {s.events.map((ev, i) => (
                  <div key={i} className="flex items-start gap-3 text-xs py-1.5 border-b border-white/[0.04] last:border-0">
                    <span className="text-muted-foreground font-mono shrink-0 w-16">{fmtAgo(ev.ts)}</span>
                    <span className={cn("font-semibold uppercase shrink-0 w-16",
                      ev.level === "error" ? "text-destructive" :
                      ev.level === "success" ? "text-neon-green" :
                      ev.level === "warn" ? "text-neon-amber" : "text-neon-cyan"
                    )}>{ev.level}</span>
                    <span className="text-foreground/90 break-all">{ev.message}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <Info className="w-4 h-4" /> No activity recorded yet — events will appear once the bot starts scraping.
              </p>
            )}
          </div>

          {!s.enabled && (
            <div className="glass-card border border-neon-amber/30 rounded-xl p-4 text-sm text-muted-foreground">
              <span className="text-neon-amber font-semibold">IMS bot is disabled.</span> Set <code className="font-mono text-foreground">IMS_ENABLED=true</code> in your VPS <code className="font-mono">backend/.env</code> file and restart pm2.
            </div>
          )}
        </>
      )}
    </div>
  );
};

const Row = ({ label, value, mono, accent }: { label: string; value: string; mono?: boolean; accent?: string }) => (
  <div className="flex items-start justify-between gap-3 py-1 border-b border-white/[0.04] last:border-0">
    <span className="text-muted-foreground text-xs uppercase tracking-wider">{label}</span>
    <span className={cn("text-right break-all", mono && "font-mono text-xs", accent || "text-foreground")}>{value}</span>
  </div>
);

const OtpIntervalSetting = ({ onSaved }: { onSaved: () => void }) => {
  const [saving, setSaving] = useState(false);
  const { data, refetch, isLoading } = useQuery({
    queryKey: ["ims-otp-interval"],
    queryFn: () => api.admin.imsOtpInterval(),
  });
  const current = data?.interval_sec ?? 10;
  const opts = data?.options ?? [5, 10, 30];

  const save = async (val: number) => {
    if (val === current) return;
    setSaving(true);
    try {
      await api.admin.imsOtpIntervalSave(val);
      toast.success(`OTP poll interval set to ${val}s — bot restarting`);
      await refetch();
      onSaved();
    } catch (e) {
      toast.error("Failed: " + (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="glass-card border border-white/[0.06] rounded-xl p-5 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Zap className="w-4 h-4 text-neon-cyan" /> OTP Poll Interval
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            How often the bot scrapes the OTP/CDR page. Lower = faster delivery, more CPU.
            {data && (
              <span className="ml-2 font-mono">
                Current: <span className="text-neon-cyan font-semibold">{current}s</span>
                <span className="text-muted-foreground/60"> ({data.source})</span>
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {opts.map((v) => (
            <button
              key={v}
              onClick={() => save(v)}
              disabled={saving || isLoading}
              className={cn(
                "px-4 py-2 rounded-md text-xs font-semibold border transition disabled:opacity-50",
                v === current
                  ? "bg-neon-cyan/15 border-neon-cyan/40 text-neon-cyan"
                  : "bg-white/[0.04] border-white/[0.08] text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
              )}
            >
              {v}s
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

// Admin-controllable OTP expiry window (5-30 min). Higher = agents have more
// time to receive an OTP before the number is auto-expired & released. Lower
// = pool recycles faster, less waste on dead numbers. Applies globally
// (IMS + AccHub + any future provider) and to the agent-side countdown timer.
const OtpExpirySetting = ({ onSaved }: { onSaved: () => void }) => {
  const [saving, setSaving] = useState(false);
  const { data, refetch, isLoading } = useQuery({
    queryKey: ["otp-expiry"],
    queryFn: () => api.admin.otpExpiry(),
  });
  const currentMin = data?.expiry_min ?? 8;
  const opts = data?.options_min ?? [5, 8, 10, 15, 20, 30];

  const save = async (min: number) => {
    if (min === currentMin) return;
    setSaving(true);
    try {
      await api.admin.otpExpirySave(min);
      toast.success(`OTP expiry set to ${min} min — agents now have ${min}m per number`);
      await refetch();
      onSaved();
    } catch (e) {
      toast.error("Failed: " + (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="glass-card border border-white/[0.06] rounded-xl p-5 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Zap className="w-4 h-4 text-neon-amber" /> OTP Expiry Window
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            How long an allocated number stays active waiting for an OTP before it's auto-released. Applies to all providers.
            {data && (
              <span className="ml-2 font-mono">
                Current: <span className="text-neon-amber font-semibold">{currentMin} min</span>
                <span className="text-muted-foreground/60"> ({data.source})</span>
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {opts.map((v) => (
            <button
              key={v}
              onClick={() => save(v)}
              disabled={saving || isLoading}
              className={cn(
                "px-4 py-2 rounded-md text-xs font-semibold border transition disabled:opacity-50",
                v === currentMin
                  ? "bg-neon-amber/15 border-neon-amber/40 text-neon-amber"
                  : "bg-white/[0.04] border-white/[0.08] text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
              )}
            >
              {v}m
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

// Admin-controllable "recent OTP" window. Drives how many hours of successful
// OTPs stay visible on the agent's live Get Number / My Numbers list — older
// ones move into the agent's permanent OTP History page (/agent/history).
// Range: 1h - 168h (7 days). Default: 24h.
const RecentOtpWindowSetting = ({ onSaved }: { onSaved: () => void }) => {
  const [saving, setSaving] = useState(false);
  const { data, refetch, isLoading } = useQuery({
    queryKey: ["recent-otp-window"],
    queryFn: () => api.admin.recentOtpWindow(),
  });
  const current = data?.hours ?? 24;
  const opts = data?.options_hours ?? [1, 6, 12, 24, 48, 72, 168];

  const fmt = (h: number) => (h >= 24 ? `${h / 24}d` : `${h}h`);

  const save = async (h: number) => {
    if (h === current) return;
    setSaving(true);
    try {
      await api.admin.recentOtpWindowSave(h);
      toast.success(`Recent OTP window set to ${fmt(h)} — older OTPs move to agent History page`);
      await refetch();
      onSaved();
    } catch (e) {
      toast.error("Failed: " + (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="glass-card border border-white/[0.06] rounded-xl p-5 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Zap className="w-4 h-4 text-neon-magenta" /> Recent OTP Visibility
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            How long delivered OTPs stay on the agent's live list before moving to permanent OTP History. Stats stay forever regardless.
            {data && (
              <span className="ml-2 font-mono">
                Current: <span className="text-neon-magenta font-semibold">{fmt(current)}</span>
                <span className="text-muted-foreground/60"> ({data.source})</span>
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {opts.map((v) => (
            <button
              key={v}
              onClick={() => save(v)}
              disabled={saving || isLoading}
              className={cn(
                "px-4 py-2 rounded-md text-xs font-semibold border transition disabled:opacity-50",
                v === current
                  ? "bg-neon-magenta/15 border-neon-magenta/40 text-neon-magenta"
                  : "bg-white/[0.04] border-white/[0.08] text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
              )}
            >
              {fmt(v)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

const CredentialsEditor = ({ onSaved }: { onSaved: () => void }) => {
  const [open, setOpen] = useState(false);
  const [showPwd, setShowPwd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ username: "", password: "", base_url: "https://www.imssms.org", enabled: true });
  const { data, refetch } = useQuery({
    queryKey: ["ims-credentials"],
    queryFn: () => api.admin.imsCredentials(),
  });

  useEffect(() => {
    if (data) setForm({
      username: data.username || "",
      password: "",
      base_url: data.base_url || "https://www.imssms.org",
      enabled: !!data.enabled,
    });
  }, [data]);

  const save = async () => {
    if (!form.username.trim()) { toast.error("Username required"); return; }
    if (!data?.has_password && !form.password) { toast.error("Password required"); return; }
    setSaving(true);
    try {
      await api.admin.imsCredentialsSave({
        username: form.username.trim(),
        password: form.password || undefined, // only send if changed
        base_url: form.base_url.trim(),
        enabled: form.enabled,
      });
      toast.success("Credentials saved — bot restarting with new login");
      setForm((f) => ({ ...f, password: "" }));
      setShowPwd(false);
      refetch();
      setTimeout(onSaved, 2000);
    } catch (e) {
      toast.error("Save failed: " + (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="glass-card border border-white/[0.06] rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between p-4 hover:bg-white/[0.02] transition"
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-neon-cyan/10 border border-neon-cyan/20 flex items-center justify-center">
            <KeyRound className="w-4 h-4 text-neon-cyan" />
          </div>
          <div className="text-left">
            <div className="text-sm font-semibold">IMS Login Credentials</div>
            <div className="text-xs text-muted-foreground">
              {data ? (
                <>
                  User: <span className="font-mono text-foreground/80">{data.username || "—"}</span> ·
                  Password: <span className="font-mono text-foreground/80">{data.password_masked || "(not set)"}</span> ·
                  Source: <span className="text-neon-cyan/80">{data.source.password}</span>
                </>
              ) : "Loading…"}
            </div>
          </div>
        </div>
        <span className="text-xs text-muted-foreground">{open ? "Hide" : "Edit"}</span>
      </button>

      {open && data && (
        <div className="border-t border-white/[0.06] p-5 space-y-4 bg-black/20">
          <p className="text-xs text-muted-foreground flex items-start gap-2">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-neon-cyan" />
            Saved credentials override the .env file and apply on next bot start. Bot will auto-restart after save.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Base URL">
              <input
                value={form.base_url}
                onChange={(e) => setForm({ ...form, base_url: e.target.value })}
                placeholder="https://www.imssms.org"
                className="w-full bg-black/40 border border-white/[0.08] rounded-md px-3 py-2 text-sm font-mono focus:border-neon-cyan/50 outline-none"
              />
            </Field>
            <Field label="IMS Username">
              <input
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                placeholder="your IMS username"
                className="w-full bg-black/40 border border-white/[0.08] rounded-md px-3 py-2 text-sm font-mono focus:border-neon-cyan/50 outline-none"
              />
            </Field>
            <Field label={data.has_password ? "New Password (leave blank to keep current)" : "IMS Password"}>
              <div className="relative">
                <input
                  type={showPwd ? "text" : "password"}
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder={data.has_password ? "•••••••• (unchanged)" : "enter password"}
                  className="w-full bg-black/40 border border-white/[0.08] rounded-md px-3 py-2 pr-10 text-sm font-mono focus:border-neon-cyan/50 outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowPwd((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
                >
                  {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </Field>
            <Field label="Bot Status">
              <label className="flex items-center gap-3 bg-black/40 border border-white/[0.08] rounded-md px-3 py-2 cursor-pointer hover:border-white/[0.15]">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                  className="w-4 h-4 accent-neon-green"
                />
                <span className="text-sm">{form.enabled ? "Enabled (auto-start on save)" : "Disabled"}</span>
              </label>
            </Field>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={() => { setOpen(false); setForm((f) => ({ ...f, password: "" })); }}
              className="px-4 py-2 rounded-md text-xs font-semibold bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] transition"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-xs font-semibold bg-neon-cyan/10 border border-neon-cyan/30 text-neon-cyan hover:bg-neon-cyan/20 transition disabled:opacity-50"
            >
              <Save className={cn("w-3.5 h-3.5", saving && "animate-pulse")} />
              {saving ? "Saving & restarting…" : "Save & Restart Bot"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="space-y-1.5">
    <label className="text-xs uppercase tracking-wider text-muted-foreground">{label}</label>
    {children}
  </div>
);

const ManualPastePool = ({ existingRanges, onAdded }: { existingRanges: string[]; onAdded: () => void }) => {
  const [open, setOpen] = useState(false);
  const [rangeMode, setRangeMode] = useState<"existing" | "new">("existing");
  const [selectedRange, setSelectedRange] = useState("");
  const [newRange, setNewRange] = useState("");
  const [countryCode, setCountryCode] = useState("");
  const [raw, setRaw] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Live parse preview
  const parsed = raw
    .split(/[\s,;\n\r\t]+/)
    .map((s) => s.replace(/[^\d+]/g, "").replace(/^\++/, "+"))
    .filter((s) => s.replace(/\D/g, "").length >= 6);
  const uniqueCount = new Set(parsed).size;

  const reset = () => {
    setRaw(""); setNewRange(""); setSelectedRange(""); setCountryCode("");
  };

  const submit = async () => {
    const range = (rangeMode === "existing" ? selectedRange : newRange).trim();
    if (!range) { toast.error("Range name required"); return; }
    if (!parsed.length) { toast.error("Paste at least one valid number"); return; }
    setSubmitting(true);
    try {
      const r = await api.imsAddPool({
        numbers: Array.from(new Set(parsed)),
        range,
        country_code: countryCode.trim() || undefined,
      });
      toast.success(`Added ${r.added} numbers to "${r.range}"` +
        (r.skipped ? ` · ${r.skipped} duplicates skipped` : "") +
        (r.invalid ? ` · ${r.invalid} invalid` : ""));
      reset();
      onAdded();
    } catch (e) {
      toast.error("Add failed: " + (e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="glass-card border border-white/[0.06] rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between p-4 hover:bg-white/[0.02] transition"
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-neon-magenta/10 border border-neon-magenta/20 flex items-center justify-center">
            <ClipboardPaste className="w-4 h-4 text-neon-magenta" />
          </div>
          <div className="text-left">
            <div className="text-sm font-semibold">Manual Paste — Add Numbers to Pool</div>
            <div className="text-xs text-muted-foreground">
              Paste copied numbers from IMS, pick a range, instantly available to agents
            </div>
          </div>
        </div>
        <span className="text-xs text-muted-foreground">{open ? "Hide" : "Open"}</span>
      </button>

      {open && (
        <div className="border-t border-white/[0.06] p-5 space-y-4 bg-black/20">
          <p className="text-xs text-muted-foreground flex items-start gap-2">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-neon-magenta" />
            Numbers are deduplicated against the current pool. Range name is what agents see in the dropdown
            (e.g. <code className="font-mono text-foreground/80">Peru Bitel TF04</code>).
          </p>

          {/* Range chooser */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Range">
              <div className="flex gap-1 mb-2">
                <button
                  type="button"
                  onClick={() => setRangeMode("existing")}
                  className={cn(
                    "px-3 py-1 rounded text-xs font-semibold transition border",
                    rangeMode === "existing"
                      ? "bg-neon-magenta/15 border-neon-magenta/40 text-neon-magenta"
                      : "bg-white/[0.03] border-white/[0.08] text-muted-foreground hover:text-foreground"
                  )}
                  disabled={!existingRanges.length}
                >
                  Existing
                </button>
                <button
                  type="button"
                  onClick={() => setRangeMode("new")}
                  className={cn(
                    "px-3 py-1 rounded text-xs font-semibold transition border inline-flex items-center gap-1",
                    rangeMode === "new"
                      ? "bg-neon-magenta/15 border-neon-magenta/40 text-neon-magenta"
                      : "bg-white/[0.03] border-white/[0.08] text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Plus className="w-3 h-3" /> New
                </button>
              </div>
              {rangeMode === "existing" ? (
                <select
                  value={selectedRange}
                  onChange={(e) => setSelectedRange(e.target.value)}
                  className="w-full bg-black/40 border border-white/[0.08] rounded-md px-3 py-2 text-sm focus:border-neon-magenta/50 outline-none"
                >
                  <option value="">— select existing range —</option>
                  {existingRanges.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              ) : (
                <input
                  value={newRange}
                  onChange={(e) => setNewRange(e.target.value)}
                  placeholder="e.g. Peru Bitel TF04"
                  className="w-full bg-black/40 border border-white/[0.08] rounded-md px-3 py-2 text-sm font-mono focus:border-neon-magenta/50 outline-none"
                />
              )}
            </Field>
            <Field label="Country Code (optional, e.g. PE)">
              <input
                value={countryCode}
                onChange={(e) => setCountryCode(e.target.value.toUpperCase())}
                maxLength={4}
                placeholder="PE"
                className="w-full bg-black/40 border border-white/[0.08] rounded-md px-3 py-2 text-sm font-mono uppercase focus:border-neon-magenta/50 outline-none"
              />
            </Field>
          </div>

          <Field label={`Numbers — paste one per line, comma, or space (${uniqueCount} unique detected)`}>
            <textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              rows={8}
              spellCheck={false}
              placeholder={"+5117654321\n+5117654322\n+5117654323\n..."}
              className="w-full bg-black/40 border border-white/[0.08] rounded-md px-3 py-2 text-sm font-mono focus:border-neon-magenta/50 outline-none resize-y"
            />
          </Field>

          {parsed.length > 0 && (
            <div className="text-xs text-muted-foreground flex flex-wrap gap-3">
              <span>Parsed: <span className="text-foreground font-mono">{parsed.length}</span></span>
              <span>Unique: <span className="text-neon-green font-mono">{uniqueCount}</span></span>
              {parsed.length !== uniqueCount && (
                <span>Duplicates in input: <span className="text-neon-amber font-mono">{parsed.length - uniqueCount}</span></span>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={reset}
              className="px-4 py-2 rounded-md text-xs font-semibold bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] transition"
            >
              Clear
            </button>
            <button
              onClick={submit}
              disabled={submitting || !uniqueCount}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-xs font-semibold bg-neon-magenta/10 border border-neon-magenta/30 text-neon-magenta hover:bg-neon-magenta/20 transition disabled:opacity-50"
            >
              <Plus className={cn("w-3.5 h-3.5", submitting && "animate-pulse")} />
              {submitting ? "Adding…" : `Add ${uniqueCount || ""} to pool`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================
// Pool Cleanup — manually purge old/expired/range numbers from the IMS pool
// ============================================================
const PoolCleanup = ({ ranges, onCleaned }: { ranges: string[]; onCleaned: () => void }) => {
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState(24);
  const [selectedRange, setSelectedRange] = useState("");
  const [busyMode, setBusyMode] = useState<string | null>(null);

  const run = async (
    mode: "expired" | "older_than" | "range" | "all_pool",
    confirmMsg: string,
    extra?: { hours?: number; range?: string }
  ) => {
    if (!confirm(confirmMsg)) return;
    setBusyMode(mode);
    try {
      const r = await api.admin.imsPoolCleanup({ mode, ...extra });
      toast.success(r.description || `Removed ${r.removed} rows`);
      onCleaned();
    } catch (e) {
      toast.error("Cleanup failed: " + (e as Error).message);
    } finally {
      setBusyMode(null);
    }
  };

  return (
    <div className="glass-card border border-white/[0.06] rounded-xl">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-4 hover:bg-white/[0.02] transition rounded-xl"
      >
        <span className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-neon-amber" /> Pool Cleanup
          <span className="text-xs text-muted-foreground/60 normal-case font-normal">
            (purge old, expired, or range-specific numbers)
          </span>
        </span>
        <span className="text-xs text-muted-foreground">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="p-5 pt-0 space-y-4 border-t border-white/[0.04]">
          {/* Mode 1: expired/completed */}
          <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-foreground">Purge expired & completed (older than 7 days)</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Deletes allocations with status <code className="text-foreground/70">expired</code> or <code className="text-foreground/70">received</code> older than a week. Safe — keeps pool & active rows.
              </div>
            </div>
            <button
              onClick={() => run("expired", "Delete all expired/completed IMS allocations older than 7 days?")}
              disabled={!!busyMode}
              className="shrink-0 inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-neon-cyan/10 border border-neon-cyan/30 text-neon-cyan hover:bg-neon-cyan/20 transition disabled:opacity-50"
            >
              <Trash2 className={cn("w-3.5 h-3.5", busyMode === "expired" && "animate-pulse")} />
              {busyMode === "expired" ? "Cleaning…" : "Run"}
            </button>
          </div>

          {/* Mode 2: pool numbers older than N hours */}
          <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-foreground">Purge pool numbers older than N hours</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Removes unused pool numbers added more than N hours ago. Use after IMS expires its stock.
              </div>
            </div>
            <div className="shrink-0 flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={720}
                value={hours}
                onChange={(e) => setHours(+e.target.value)}
                className="w-20 px-2 py-1.5 rounded-md bg-black/30 border border-white/[0.08] text-sm font-mono text-foreground focus:outline-none focus:border-neon-amber/40"
              />
              <span className="text-xs text-muted-foreground">hours</span>
              <button
                onClick={() => run("older_than", `Delete pool numbers older than ${hours} hour(s)?`, { hours })}
                disabled={!!busyMode}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-neon-amber/10 border border-neon-amber/30 text-neon-amber hover:bg-neon-amber/20 transition disabled:opacity-50"
              >
                <Trash2 className={cn("w-3.5 h-3.5", busyMode === "older_than" && "animate-pulse")} />
                {busyMode === "older_than" ? "Cleaning…" : "Run"}
              </button>
            </div>
          </div>

          {/* Mode 3: by range */}
          <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-foreground">Purge a specific range</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Deletes all unused pool numbers from one IMS range (e.g. when a country/operator is dead).
              </div>
            </div>
            <div className="shrink-0 flex items-center gap-2">
              <select
                value={selectedRange}
                onChange={(e) => setSelectedRange(e.target.value)}
                className="px-2 py-1.5 rounded-md bg-black/30 border border-white/[0.08] text-sm text-foreground focus:outline-none focus:border-neon-amber/40 max-w-[220px]"
              >
                <option value="">— pick a range —</option>
                {ranges.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              <button
                onClick={() => selectedRange
                  ? run("range", `Delete ALL pool numbers from "${selectedRange}"?`, { range: selectedRange })
                  : toast.error("Pick a range first")}
                disabled={!!busyMode || !selectedRange}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-neon-magenta/10 border border-neon-magenta/30 text-neon-magenta hover:bg-neon-magenta/20 transition disabled:opacity-50"
              >
                <Trash2 className={cn("w-3.5 h-3.5", busyMode === "range" && "animate-pulse")} />
                {busyMode === "range" ? "Cleaning…" : "Run"}
              </button>
            </div>
          </div>

          {/* Mode 4: nuke all pool */}
          <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-destructive/[0.04] border border-destructive/20">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-destructive">Nuke entire pool ⚠️</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Deletes EVERY unused number from the IMS pool. Active allocations are kept. Bot will refill on next scrape.
              </div>
            </div>
            <button
              onClick={() => run("all_pool", "⚠️ DELETE the entire IMS pool? This cannot be undone. Active allocations are kept.")}
              disabled={!!busyMode}
              className="shrink-0 inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-destructive/10 border border-destructive/30 text-destructive hover:bg-destructive/20 transition disabled:opacity-50"
            >
              <Trash2 className={cn("w-3.5 h-3.5", busyMode === "all_pool" && "animate-pulse")} />
              {busyMode === "all_pool" ? "Nuking…" : "Nuke"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default AdminImsStatus;

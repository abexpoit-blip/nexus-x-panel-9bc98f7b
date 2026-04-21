import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { GradientMesh, PageHeader } from "@/components/premium";
import {
  Bot, CheckCircle2, XCircle, Activity, Database, MessageSquareText,
  RefreshCw, Power, Play, Square, Zap, Sparkles, Layers, Clock, Trash2,
  Heart, AlertOctagon, History as HistoryIcon, Pause, PlayCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type XisoraStatus = {
  enabled: boolean; running: boolean; loggedIn: boolean;
  lastLoginAt: number | null; lastScrapeAt: number | null; lastScrapeOk: boolean;
  lastNumbersScrapeAt: number | null;
  lastError: string | null; lastErrorAt: number | null;
  totalScrapes: number; numbersScrapedTotal: number; numbersAddedTotal: number;
  otpsDeliveredTotal: number; consecFail: number;
  baseUrl: string; otpIntervalSec: number; numbersIntervalSec: number;
  poolSize: number; claimingSize: number; activeAssigned: number; otpReceived: number;
  otpCacheSize: number; emptyStreak: number;
  heartbeatAt: number | null; heartbeatAgeSec: number | null;
  queueDepth: number;
  lastSuccessAt: number | null; sinceLastSuccessSec: number | null;
  staleSession: boolean; staleThresholdSec: number;
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

const AdminXisoraStatus = () => {
  const [busy, setBusy] = useState(false);
  const [scraping, setScraping] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["xisora-status"],
    queryFn: () => api.admin.xisoraStatus(),
    refetchInterval: 5000,
  });
  const { data: poolData, refetch: refetchPool } = useQuery({
    queryKey: ["xisora-pool-breakdown"],
    queryFn: () => api.admin.xisoraPoolBreakdown(),
    refetchInterval: 10000,
  });
  const { data: runsData, refetch: refetchRuns } = useQuery({
    queryKey: ["xisora-runs"],
    queryFn: () => api.admin.xisoraRuns(50),
    refetchInterval: 8000,
  });
  const s = data?.status as XisoraStatus | undefined;

  const handleAction = async (action: "restart" | "start" | "stop") => {
    const labels = { restart: "Restart", start: "Start", stop: "Stop" };
    if (action === "stop" && !confirm("Stop the XISORA bot? It will stop polling until restarted.")) return;
    if (action === "restart" && !confirm("Restart the XISORA bot? Current poll will be interrupted.")) return;
    setBusy(true);
    try {
      if (action === "restart") await api.admin.xisoraRestart();
      else if (action === "start") await api.admin.xisoraStart();
      else await api.admin.xisoraStop();
      toast.success(`${labels[action]} initiated`);
      setTimeout(() => refetch(), 1500);
    } catch (e) {
      toast.error(`${labels[action]} failed: ` + (e as Error).message);
    } finally { setBusy(false); }
  };

  const handleScrapeNow = async () => {
    setScraping(true);
    try {
      const r = await api.admin.xisoraScrapeNow();
      if (r.ok) toast.success(`Scrape complete: ${r.otps ?? 0} OTPs delivered`);
      else toast.error(r.error || "Scrape failed");
      refetch(); refetchPool();
    } catch (e) {
      toast.error("Scrape failed: " + (e as Error).message);
    } finally { setScraping(false); refetchRuns(); }
  };

  const handleSyncLive = async () => {
    if (!confirm(
      "Live Sync will:\n" +
      "  • ADD any new numbers XISORA has\n" +
      "  • REMOVE pool numbers XISORA no longer shows\n" +
      "  • Active assigned numbers are NEVER touched\n\nContinue?"
    )) return;
    setSyncing(true);
    try {
      const r = await api.admin.xisoraSyncLive();
      if (r.ok) toast.success(
        `Live sync done: +${r.added ?? 0} added · -${r.removed ?? 0} removed · ${r.kept ?? 0} kept (${r.scraped ?? 0} live)`,
        { duration: 6000 }
      );
      else toast.error(r.error || "Live sync failed");
      refetch(); refetchPool();
    } catch (e) {
      toast.error("Live sync failed: " + (e as Error).message);
    } finally { setSyncing(false); refetchRuns(); }
  };

  const handleCleanupRange = async (range: string) => {
    if (!confirm(`Remove ALL pool numbers in range "${range}"? Active numbers untouched.`)) return;
    try {
      const r = await api.admin.xisoraPoolCleanup({ range });
      toast.success(`Removed ${r.removed} numbers from "${range}"`);
      refetch(); refetchPool();
    } catch (e) { toast.error("Cleanup failed: " + (e as Error).message); }
  };

  const handleToggleRange = async (range: string, currentlyDisabled: boolean) => {
    try {
      const r = await api.admin.xisoraRangeToggle(range, !currentlyDisabled);
      toast.success(`Range "${range}" ${r.disabled ? "disabled" : "enabled"}`);
      refetchPool();
    } catch (e) { toast.error("Toggle failed: " + (e as Error).message); }
  };

  return (
    <div className="relative space-y-6">
      <GradientMesh variant="default" />
      <PageHeader
        eyebrow="Workers"
        title="XISORA SMS Bot Status"
        description="Pure HTTP cookie-session worker — no captcha, no Puppeteer, instant OTP delivery"
        icon={<Bot className="w-5 h-5 text-neon-cyan" />}
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            {s?.running ? (
              <button onClick={() => handleAction("stop")} disabled={busy}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-destructive/10 border border-destructive/30 text-destructive hover:bg-destructive/20 transition disabled:opacity-50">
                <Square className="w-3.5 h-3.5" /> Stop
              </button>
            ) : (
              <button onClick={() => handleAction("start")} disabled={busy}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-neon-green/10 border border-neon-green/30 text-neon-green hover:bg-neon-green/20 transition disabled:opacity-50">
                <Play className="w-3.5 h-3.5" /> Start
              </button>
            )}
            <button onClick={handleScrapeNow} disabled={scraping || !s?.running}
              title={!s?.running ? "Start the bot first" : "Run an OTP poll right now"}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-neon-cyan/10 border border-neon-cyan/30 text-neon-cyan hover:bg-neon-cyan/20 transition disabled:opacity-50">
              <Zap className={cn("w-3.5 h-3.5", scraping && "animate-pulse")} />
              {scraping ? "Scraping…" : "Scrape Now"}
            </button>
            <button onClick={handleSyncLive} disabled={syncing || !s?.running}
              title={!s?.running ? "Start the bot first" : "Reconcile pool with XISORA panel"}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-neon-amber/10 border border-neon-amber/30 text-neon-amber hover:bg-neon-amber/20 transition disabled:opacity-50">
              <Sparkles className={cn("w-3.5 h-3.5", syncing && "animate-pulse")} />
              {syncing ? "Syncing…" : "Sync Live"}
            </button>
            <button onClick={() => handleAction("restart")} disabled={busy}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-neon-magenta/10 border border-neon-magenta/30 text-neon-magenta hover:bg-neon-magenta/20 transition disabled:opacity-50">
              <Power className={cn("w-3.5 h-3.5", busy && "animate-spin")} /> {busy ? "Working…" : "Restart"}
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
            {s.staleSession && <Pill ok={false} label="Stale session" />}
          </div>

          {/* Worker health panel */}
          <div className={cn(
            "glass-card rounded-xl p-4 border",
            s.staleSession ? "border-destructive/40 bg-destructive/5" : "border-white/[0.06]"
          )}>
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-semibold flex items-center gap-2">
                <Heart className={cn("w-4 h-4",
                  s.staleSession ? "text-destructive animate-pulse" :
                  (s.heartbeatAgeSec ?? 999) < (s.otpIntervalSec * 2) ? "text-neon-green animate-pulse" :
                  "text-neon-amber"
                )} />
                Worker health
              </div>
              {s.staleSession && (
                <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-destructive">
                  <AlertOctagon className="w-3.5 h-3.5" /> No success in {s.sinceLastSuccessSec}s — restart recommended
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Last heartbeat</div>
                <div className={cn("font-mono text-base font-bold",
                  (s.heartbeatAgeSec ?? 999) < (s.otpIntervalSec * 2) ? "text-neon-green" : "text-neon-amber")}>
                  {s.heartbeatAgeSec === null ? "never" : `${s.heartbeatAgeSec}s ago`}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Last successful poll</div>
                <div className={cn("font-mono text-base font-bold",
                  s.staleSession ? "text-destructive" : "text-neon-green")}>
                  {s.lastSuccessAt ? `${s.sinceLastSuccessSec}s ago` : "never"}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Queue depth</div>
                <div className="font-mono text-base font-bold text-neon-cyan">
                  {s.queueDepth} <span className="text-xs text-muted-foreground font-normal">awaiting OTP</span>
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Stale threshold</div>
                <div className="font-mono text-base font-bold text-muted-foreground">{s.staleThresholdSec}s</div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat icon={<Layers className="w-3.5 h-3.5" />} label="Pool size" value={s.poolSize ?? 0}
              hint={`${s.claimingSize ?? 0} claiming`} accent="text-neon-cyan" />
            <Stat icon={<Activity className="w-3.5 h-3.5" />} label="Active assigned" value={s.activeAssigned ?? 0}
              hint={`${s.otpReceived ?? 0} delivered`} accent="text-neon-amber" />
            <Stat icon={<MessageSquareText className="w-3.5 h-3.5" />} label="OTPs delivered" value={s.otpsDeliveredTotal ?? 0}
              hint={`cache ${s.otpCacheSize ?? 0}`} accent="text-neon-green" />
            <Stat icon={<Database className="w-3.5 h-3.5" />} label="Numbers added (lifetime)" value={s.numbersAddedTotal ?? 0}
              hint={`${s.numbersScrapedTotal ?? 0} scanned`} />
            <Stat icon={<Clock className="w-3.5 h-3.5" />} label="Last login" value={fmtAgo(s.lastLoginAt)} />
            <Stat icon={<Clock className="w-3.5 h-3.5" />} label="Last OTP poll" value={fmtAgo(s.lastScrapeAt)}
              hint={`every ${s.otpIntervalSec ?? 4}s`} />
            <Stat icon={<Clock className="w-3.5 h-3.5" />} label="Last pool sync" value={fmtAgo(s.lastNumbersScrapeAt)}
              hint={`every ${Math.round((s.numbersIntervalSec ?? 600) / 60)}min`} />
            <Stat icon={<XCircle className="w-3.5 h-3.5" />} label="Consec failures" value={s.consecFail ?? 0}
              hint={s.lastError ? `last: ${fmtAgo(s.lastErrorAt)}` : "none"}
              accent={(s.consecFail ?? 0) > 0 ? "text-destructive" : "text-neon-green"} />
          </div>

          {s.lastError && (
            <div className="glass-card border border-destructive/30 rounded-xl p-4 bg-destructive/5">
              <div className="text-xs uppercase tracking-wider text-destructive font-bold mb-1">
                Last error · {fmtAgo(s.lastErrorAt)}
              </div>
              <div className="font-mono text-xs text-destructive/90 break-all">{s.lastError}</div>
            </div>
          )}

          <div className="glass-card border border-white/[0.06] rounded-xl p-4 text-xs text-muted-foreground space-y-1">
            <div><span className="font-semibold text-foreground">Base URL:</span> <span className="font-mono">{s.baseUrl || "—"}</span></div>
            <div><span className="font-semibold text-foreground">OTP poll:</span> every <span className="font-mono">{s.otpIntervalSec}s</span> · <span className="font-semibold text-foreground">Pool sync:</span> every <span className="font-mono">{s.numbersIntervalSec}s</span></div>
            <div><span className="font-semibold text-foreground">Total scrapes:</span> <span className="font-mono">{s.totalScrapes}</span> · <span className="font-semibold text-foreground">Empty streak:</span> <span className="font-mono">{s.emptyStreak ?? 0}</span></div>
          </div>

          {/* Pool breakdown by range */}
          {poolData && poolData.ranges.length > 0 && (
            <div className="glass-card border border-white/[0.06] rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-semibold flex items-center gap-2">
                  <Layers className="w-4 h-4 text-neon-cyan" />
                  Pool by range ({poolData.ranges.length})
                </div>
                <div className="text-xs text-muted-foreground">
                  active: <span className="font-mono text-neon-amber">{poolData.totalActive}</span>
                  {typeof poolData.totalUsed === "number" && <> · used: <span className="font-mono">{poolData.totalUsed}</span></>}
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                {poolData.ranges.map(r => {
                  const isDisabled = !!r.disabled;
                  return (
                    <div key={r.name} className={cn(
                      "flex items-center justify-between gap-2 px-3 py-2 rounded-md border transition",
                      isDisabled
                        ? "bg-white/[0.01] border-white/[0.04] opacity-60"
                        : "bg-white/[0.03] border-white/[0.05]"
                    )}>
                      <div className="min-w-0">
                        <div className="text-sm font-mono truncate flex items-center gap-2">
                          {r.custom_name || r.name}
                          {isDisabled && <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-destructive/15 text-destructive font-bold">Paused</span>}
                        </div>
                        <div className="text-[10px] text-muted-foreground">last +{fmtAgo(r.last_added)}</div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-sm font-bold font-mono text-neon-cyan">{r.count}</span>
                        <button onClick={() => handleToggleRange(r.name, isDisabled)}
                          title={isDisabled ? "Resume scraping this range" : "Pause scraping this range (numbers stay in pool)"}
                          className={cn("p-1 rounded transition",
                            isDisabled
                              ? "hover:bg-neon-green/15 text-muted-foreground hover:text-neon-green"
                              : "hover:bg-neon-amber/15 text-muted-foreground hover:text-neon-amber"
                          )}>
                          {isDisabled ? <PlayCircle className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                        </button>
                        <button onClick={() => handleCleanupRange(r.name)} title="Purge this range from pool"
                          className="p-1 rounded hover:bg-destructive/15 text-muted-foreground hover:text-destructive transition">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Run history */}
          {runsData && runsData.runs.length > 0 && (
            <div className="glass-card border border-white/[0.06] rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-semibold flex items-center gap-2">
                  <HistoryIcon className="w-4 h-4 text-neon-purple" />
                  Run history ({runsData.runs.length})
                </div>
                <button onClick={() => refetchRuns()}
                  className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-[10px] uppercase tracking-wider bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] transition">
                  <RefreshCw className="w-3 h-3" /> Refresh
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b border-white/[0.06]">
                      <th className="py-2 pr-3">Kind</th>
                      <th className="py-2 pr-3">Started</th>
                      <th className="py-2 pr-3">Duration</th>
                      <th className="py-2 pr-3">Result</th>
                      <th className="py-2 pr-3">By</th>
                      <th className="py-2 pr-0">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runsData.runs.map(run => (
                      <tr key={run.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                        <td className="py-2 pr-3">
                          <span className={cn("inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider",
                            run.kind === "scrape-now" && "bg-neon-cyan/15 text-neon-cyan",
                            run.kind === "sync-live" && "bg-neon-amber/15 text-neon-amber",
                            run.kind.startsWith("auto") && "bg-white/[0.05] text-muted-foreground",
                          )}>{run.kind}</span>
                        </td>
                        <td className="py-2 pr-3 font-mono text-muted-foreground whitespace-nowrap">{fmtAgo(run.started_at)}</td>
                        <td className="py-2 pr-3 font-mono">{run.duration_ms != null ? `${run.duration_ms}ms` : "—"}</td>
                        <td className="py-2 pr-3">
                          {run.ok ? (
                            <span className="inline-flex items-center gap-1 text-neon-green font-bold">
                              <CheckCircle2 className="w-3 h-3" /> OK
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-destructive font-bold">
                              <XCircle className="w-3 h-3" /> FAIL
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-3 font-mono text-muted-foreground">{run.triggered_by}</td>
                        <td className="py-2 pr-0 font-mono text-muted-foreground max-w-md">
                          {run.error
                            ? <span className="text-destructive break-all" title={run.error}>{run.error}</span>
                            : run.kind === "scrape-now"
                              ? <span>OTPs: <span className="text-neon-green font-bold">{run.otps}</span></span>
                              : <span>+{run.added} / -{run.removed} / kept {run.kept} / scraped {run.scraped}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Recent events */}
          {s.events && s.events.length > 0 && (
            <div className="glass-card border border-white/[0.06] rounded-xl p-4">
              <div className="text-sm font-semibold mb-3 flex items-center gap-2">
                <Activity className="w-4 h-4 text-neon-magenta" /> Recent activity
              </div>
              <div className="space-y-1.5 max-h-80 overflow-y-auto">
                {s.events.map((ev, i) => (
                  <div key={i} className="flex items-start gap-3 text-xs font-mono px-2 py-1.5 rounded bg-white/[0.02]">
                    <span className={cn("uppercase font-bold tracking-wider shrink-0 w-14",
                      ev.level === "error" && "text-destructive",
                      ev.level === "warn" && "text-neon-amber",
                      ev.level === "success" && "text-neon-green",
                      ev.level === "info" && "text-muted-foreground",
                    )}>{ev.level}</span>
                    <span className="text-muted-foreground shrink-0 w-16">{fmtAgo(ev.ts)}</span>
                    <span className="break-all">{ev.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default AdminXisoraStatus;
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { GradientMesh, PageHeader } from "@/components/premium";
import { Bot, CheckCircle2, XCircle, Activity, Database, MessageSquareText, AlertTriangle, RefreshCw, Power, Info, Play, Square } from "lucide-react";
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
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["ims-status"],
    queryFn: () => api.admin.imsStatus(),
    refetchInterval: 5000,
  });
  const s = data?.status as ImsStatus | undefined;

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
              onClick={() => handleAction("restart")}
              disabled={restarting}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-neon-magenta/10 border border-neon-magenta/30 text-neon-magenta hover:bg-neon-magenta/20 transition disabled:opacity-50"
            >
              <Power className={cn("w-3.5 h-3.5", restarting && "animate-spin")} /> {restarting ? "Working…" : "Restart"}
            </button>
            <button
              onClick={() => refetch()}
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

export default AdminImsStatus;

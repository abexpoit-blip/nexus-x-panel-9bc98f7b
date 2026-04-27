import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/premium/PageHeader";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  Bot, ExternalLink, RefreshCw, CircleCheck, CircleAlert, PowerOff, CircleDashed,
  Play, Square, RotateCw, Timer, Save,
} from "lucide-react";

type BotEntry = {
  key: string;
  label: string;
  panel: string;
  route: string;
  fetcher: () => Promise<{ status: any }>;
  start: () => Promise<{ ok: boolean }>;
  stop: () => Promise<{ ok: boolean }>;
  restart: () => Promise<{ ok: boolean }>;
};

const BOTS: BotEntry[] = [
  { key: "ims",         label: "IMS",          panel: "imssms.org",            route: "/admin/ims-status",         fetcher: () => api.admin.imsStatus(),       start: () => api.admin.imsStart(),       stop: () => api.admin.imsStop(),       restart: () => api.admin.imsRestart() },
  { key: "msi",         label: "MSI",          panel: "145.239.130.45/ints",   route: "/admin/msi-status",         fetcher: () => api.admin.msiStatus(),       start: () => api.admin.msiStart(),       stop: () => api.admin.msiStop(),       restart: () => api.admin.msiRestart() },
  { key: "numpanel",    label: "NumPanel",     panel: "51.89.99.105",          route: "/admin/numpanel-status",    fetcher: () => api.admin.numpanelStatus(),  start: () => api.admin.numpanelStart(),  stop: () => api.admin.numpanelStop(),  restart: () => api.admin.numpanelRestart() },
  { key: "iprn_sms",    label: "IPRN-SMS",     panel: "panel.iprn-sms.com",    route: "/admin/iprn-sms-status",    fetcher: () => api.iprnSms.status(),        start: () => api.iprnSms.start(),        stop: () => api.iprnSms.stop(),        restart: () => api.iprnSms.restart() },
  { key: "iprn_sms_v2", label: "IPRN-SMS V2",  panel: "panel.iprn-sms.com",    route: "/admin/iprn-sms-v2-status", fetcher: () => api.iprnSmsV2.status(),      start: () => api.iprnSmsV2.start(),      stop: () => api.iprnSmsV2.stop(),      restart: () => api.iprnSmsV2.restart() },
  { key: "seven1tel",   label: "Seven1Tel",    panel: "94.23.120.156/ints",    route: "/admin/seven1tel-status",   fetcher: () => api.admin.seven1telStatus(), start: () => api.admin.seven1telStart(), stop: () => api.admin.seven1telStop(), restart: () => api.admin.seven1telRestart() },
];

function fmtAgo(ts: number | null | undefined): string {
  if (!ts) return "never";
  const sec = Math.floor(Date.now() / 1000) - ts;
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function BotCard({ bot }: { bot: BotEntry }) {
  const [s, setS] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | "start" | "stop" | "restart">(null);

  const load = async () => {
    try {
      const r = await bot.fetcher();
      setS(r?.status ?? r);
      setErr(null);
    } catch (e: any) {
      setErr(e?.message || "Unreachable");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); const i = setInterval(load, 15_000); return () => clearInterval(i); }, []);

  const act = async (kind: "start" | "stop" | "restart") => {
    setBusy(kind);
    try {
      await bot[kind]();
      toast.success(`${bot.label}: ${kind} OK`);
      setTimeout(load, 600);
    } catch (e: any) {
      toast.error(`${bot.label} ${kind} failed: ${e?.message || "error"}`);
    } finally {
      setBusy(null);
    }
  };

  const enabled = !!s?.enabled;
  const running = !!s?.running;
  const loggedIn = !!s?.loggedIn;
  const pool = s?.poolSize ?? s?.totalPool ?? 0;
  const otps = s?.otpsDeliveredTotal ?? s?.otpsDelivered ?? 0;
  const lastSync = s?.lastNumbersScrapeAt ?? s?.lastScrapeAt ?? s?.lastSyncAt ?? null;
  const lastError = s?.lastError;

  const tone =
    err ? "border-rose-500/30 bg-rose-500/5"
    : !enabled ? "border-white/[0.06]"
    : !running ? "border-rose-500/30 bg-rose-500/5"
    : !loggedIn ? "border-amber-500/30 bg-amber-500/5"
    : "border-emerald-500/20 bg-emerald-500/5";

  const Pill = () => {
    if (err) return <Badge className="bg-rose-600/40"><CircleAlert className="h-3 w-3 mr-1" />Offline</Badge>;
    if (!enabled) return <Badge className="bg-zinc-600/40"><PowerOff className="h-3 w-3 mr-1" />Disabled</Badge>;
    if (!running) return <Badge className="bg-rose-600/40"><CircleAlert className="h-3 w-3 mr-1" />Stopped</Badge>;
    if (!loggedIn) return <Badge className="bg-amber-600/40"><CircleAlert className="h-3 w-3 mr-1" />Not logged in</Badge>;
    return <Badge className="bg-emerald-600/40"><CircleCheck className="h-3 w-3 mr-1" />Live</Badge>;
  };

  return (
    <Card className={`transition-colors ${tone}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base flex items-center gap-2">
              <Bot className="h-4 w-4 text-primary" />
              {bot.label}
            </CardTitle>
            <div className="text-[11px] text-muted-foreground mt-0.5 truncate">{bot.panel}</div>
          </div>
          {loading ? <CircleDashed className="h-4 w-4 animate-spin text-muted-foreground" /> : <Pill />}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-white/[0.03] py-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Pool</div>
            <div className="text-lg font-bold">{pool.toLocaleString()}</div>
          </div>
          <div className="rounded-lg bg-white/[0.03] py-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">OTPs</div>
            <div className="text-lg font-bold">{otps.toLocaleString()}</div>
          </div>
          <div className="rounded-lg bg-white/[0.03] py-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Last sync</div>
            <div className="text-xs font-medium pt-1">{fmtAgo(lastSync)}</div>
          </div>
        </div>

        {(err || lastError) && (
          <div className="text-[11px] text-rose-300/90 bg-rose-500/10 rounded p-2 truncate">
            {err || lastError}
          </div>
        )}

        <div className="grid grid-cols-3 gap-1.5">
          <Button size="sm" variant="outline" disabled={!!busy || running} onClick={() => act("start")}>
            {busy === "start" ? <CircleDashed className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3 mr-1" />}
            Start
          </Button>
          <Button size="sm" variant="outline" disabled={!!busy || !running} onClick={() => act("stop")}>
            {busy === "stop" ? <CircleDashed className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3 mr-1" />}
            Stop
          </Button>
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => act("restart")}>
            {busy === "restart" ? <CircleDashed className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3 mr-1" />}
            Restart
          </Button>
        </div>
        <Link to={bot.route}>
          <Button size="sm" variant="ghost" className="w-full">
            Manage <ExternalLink className="h-3 w-3 ml-1.5" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}

export default function Bots() {
  const [tick, setTick] = useState(0);
  const [bulkBusy, setBulkBusy] = useState<null | "start" | "stop" | "restart">(null);

  const bulk = async (kind: "start" | "stop" | "restart") => {
    if (kind === "stop" && !confirm("Stop ALL bots? This will halt every scraper.")) return;
    setBulkBusy(kind);
    const results = await Promise.allSettled(BOTS.map((b) => b[kind]()));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const fail = results.length - ok;
    if (fail === 0) toast.success(`${kind}: all ${ok} bots OK`);
    else toast.warning(`${kind}: ${ok} OK · ${fail} failed`);
    setBulkBusy(null);
    setTick((t) => t + 1);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="All Bots"
        description="Live status + start/stop/restart for every scraping bot in one place."
        actions={
          <Button size="sm" variant="outline" onClick={() => setTick((t) => t + 1)}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Refresh all
          </Button>
        }
      />
      <Card className="border-white/[0.06]">
        <CardContent className="p-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">Bulk actions — every bot</div>
            <div className="text-xs text-muted-foreground">Applies to all {BOTS.length} bots simultaneously.</div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={!!bulkBusy} onClick={() => bulk("start")}>
              {bulkBusy === "start" ? <CircleDashed className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Play className="h-3.5 w-3.5 mr-1.5" />}
              Start all
            </Button>
            <Button size="sm" variant="outline" disabled={!!bulkBusy} onClick={() => bulk("restart")}>
              {bulkBusy === "restart" ? <CircleDashed className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5 mr-1.5" />}
              Restart all
            </Button>
            <Button size="sm" variant="destructive" disabled={!!bulkBusy} onClick={() => bulk("stop")}>
              {bulkBusy === "stop" ? <CircleDashed className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Square className="h-3.5 w-3.5 mr-1.5" />}
              Stop all
            </Button>
          </div>
        </CardContent>
      </Card>
      <div key={tick} className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {BOTS.map((b) => <BotCard key={b.key} bot={b} />)}
      </div>

      <AutoPoolQuickPanel />
    </div>
  );
}

/**
 * Compact per-bot scrape-interval / TTL / cap editor for the hub.
 * Heavier controls + run-now live on each bot's individual status page.
 */
function AutoPoolQuickPanel() {
  const [bots, setBots] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { enabled: boolean; interval_min: number; ttl_min: number; max_size: number }>>({});

  const load = async () => {
    try {
      const r = await api.autopool.list();
      setBots(r.bots || []);
      const d: typeof drafts = {};
      for (const b of r.bots || []) {
        d[b.botId] = {
          enabled: !!b.config?.enabled,
          interval_min: b.config?.interval_min ?? 15,
          ttl_min: b.config?.ttl_min ?? 360,
          max_size: b.config?.max_size ?? 5000,
        };
      }
      setDrafts(d);
    } catch (e: any) {
      toast.error(`Auto-pool load: ${e?.message || "error"}`);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); const i = setInterval(load, 30_000); return () => clearInterval(i); }, []);

  const save = async (botId: string) => {
    setSavingId(botId);
    try {
      await api.autopool.save(botId, drafts[botId]);
      toast.success(`${botId}: auto-pool saved`);
      load();
    } catch (e: any) {
      toast.error(`${botId} save failed: ${e?.message || "error"}`);
    } finally { setSavingId(null); }
  };

  return (
    <Card className="border-white/[0.06]">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Timer className="h-4 w-4 text-primary" /> Auto-pool quick edit
        </CardTitle>
        <div className="text-xs text-muted-foreground">
          Enable a bot's scheduler and tune scrape interval / stale TTL / pool cap. Open the bot's page for run-now and live results.
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="text-sm text-muted-foreground flex items-center gap-2">
            <CircleDashed className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : bots.length === 0 ? (
          <div className="text-sm text-muted-foreground">No bots registered.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-muted-foreground border-b border-white/[0.06]">
                  <th className="text-left py-2 pr-3">Bot</th>
                  <th className="text-center px-2">On</th>
                  <th className="text-center px-2">Interval (min)</th>
                  <th className="text-center px-2">TTL (min)</th>
                  <th className="text-center px-2">Max size</th>
                  <th className="text-center px-2">Pool</th>
                  <th className="text-right pl-2"></th>
                </tr>
              </thead>
              <tbody>
                {bots.map((b) => {
                  const d = drafts[b.botId] || { enabled: false, interval_min: 15, ttl_min: 360, max_size: 5000 };
                  return (
                    <tr key={b.botId} className="border-b border-white/[0.04] last:border-0">
                      <td className="py-2 pr-3 font-medium">{b.label}</td>
                      <td className="px-2 text-center">
                        <Switch checked={d.enabled} onCheckedChange={(v) => setDrafts((s) => ({ ...s, [b.botId]: { ...d, enabled: !!v } }))} />
                      </td>
                      <td className="px-2"><Input type="number" className="h-8 w-20 mx-auto text-center" value={d.interval_min} onChange={(e) => setDrafts((s) => ({ ...s, [b.botId]: { ...d, interval_min: +e.target.value || 0 } }))} /></td>
                      <td className="px-2"><Input type="number" className="h-8 w-20 mx-auto text-center" value={d.ttl_min} onChange={(e) => setDrafts((s) => ({ ...s, [b.botId]: { ...d, ttl_min: +e.target.value || 0 } }))} /></td>
                      <td className="px-2"><Input type="number" className="h-8 w-24 mx-auto text-center" value={d.max_size} onChange={(e) => setDrafts((s) => ({ ...s, [b.botId]: { ...d, max_size: +e.target.value || 0 } }))} /></td>
                      <td className="px-2 text-center font-semibold">{(b.pool ?? 0).toLocaleString()}</td>
                      <td className="pl-2 text-right">
                        <Button size="sm" variant="outline" disabled={savingId === b.botId} onClick={() => save(b.botId)}>
                          {savingId === b.botId ? <CircleDashed className="h-3.5 w-3.5 animate-spin" /> : <><Save className="h-3.5 w-3.5 mr-1.5" />Save</>}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

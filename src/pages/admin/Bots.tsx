import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/premium/PageHeader";
import { api } from "@/lib/api";
import {
  Bot, ExternalLink, RefreshCw, CircleCheck, CircleAlert, PowerOff, CircleDashed,
} from "lucide-react";

type BotEntry = {
  key: string;
  label: string;
  panel: string;
  route: string;
  fetcher: () => Promise<{ status: any }>;
};

const BOTS: BotEntry[] = [
  { key: "ims",         label: "IMS",          panel: "imssms.org",            route: "/admin/ims-status",        fetcher: () => api.imsBot.status() as any },
  { key: "msi",         label: "MSI",          panel: "145.239.130.45/ints",   route: "/admin/msi-status",        fetcher: () => api.msiBot.status() as any },
  { key: "numpanel",    label: "NumPanel",     panel: "51.89.99.105",          route: "/admin/numpanel-status",   fetcher: () => api.admin.numpanelStatus() },
  { key: "iprn",        label: "IPRN",         panel: "iprndata.com",          route: "/admin/iprn-status",       fetcher: () => api.iprn.status() },
  { key: "iprn_sms",    label: "IPRN-SMS",     panel: "panel.iprn-sms.com",    route: "/admin/iprn-sms-status",   fetcher: () => api.iprnSms.status() },
  { key: "iprn_sms_v2", label: "IPRN-SMS V2",  panel: "panel.iprn-sms.com",    route: "/admin/iprn-sms-v2-status", fetcher: () => api.iprnSmsV2.status() },
  { key: "seven1tel",   label: "Seven1Tel",    panel: "94.23.120.156/ints",    route: "/admin/seven1tel-status",  fetcher: () => api.seven1tel.status() as any },
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

        <Link to={bot.route}>
          <Button size="sm" variant="outline" className="w-full">
            Manage <ExternalLink className="h-3 w-3 ml-1.5" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}

export default function Bots() {
  const [tick, setTick] = useState(0);
  return (
    <div className="space-y-6">
      <PageHeader
        title="All Bots"
        description="Live status across every scraping bot. Click any card to manage credentials, sync, and pool."
        actions={
          <Button size="sm" variant="outline" onClick={() => setTick((t) => t + 1)}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Refresh all
          </Button>
        }
      />
      <div key={tick} className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {BOTS.map((b) => <BotCard key={b.key} bot={b} />)}
      </div>
    </div>
  );
}

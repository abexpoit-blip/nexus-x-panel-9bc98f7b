import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { CircleDashed, Play, Save, Timer } from "lucide-react";

function fmtAgo(ts: number | null): string {
  if (!ts) return "never";
  const sec = Math.floor(Date.now() / 1000) - ts;
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

/**
 * Per-bot auto-pool controls. Drop into any bot status page:
 *   <AutoPoolCard botId="msi" />
 * Skip on IMS — IMS already has its own dedicated controls.
 */
export function AutoPoolCard({ botId, compact = false }: { botId: string; compact?: boolean }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [form, setForm] = useState({ enabled: false, interval_min: 15, ttl_min: 360, max_size: 5000 });

  const load = async () => {
    try {
      const r = await api.autopool.get(botId);
      setData(r.bot);
      setForm({
        enabled: !!r.bot?.config?.enabled,
        interval_min: r.bot?.config?.interval_min ?? 15,
        ttl_min: r.bot?.config?.ttl_min ?? 360,
        max_size: r.bot?.config?.max_size ?? 5000,
      });
    } catch (e: any) {
      toast.error(`Auto-pool load failed: ${e?.message || "error"}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); const i = setInterval(load, 20_000); return () => clearInterval(i); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [botId]);

  const save = async () => {
    setSaving(true);
    try {
      await api.autopool.save(botId, form);
      toast.success("Auto-pool settings saved");
      load();
    } catch (e: any) {
      toast.error(`Save failed: ${e?.message || "error"}`);
    } finally { setSaving(false); }
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const r = await api.autopool.runNow(botId);
      const res = r.result;
      if (res) toast.success(`Run OK · pool ${res.poolBefore}→${res.poolAfter} · pruned ${res.pruned} · capped ${res.capped}`);
      else toast.success("Run triggered");
      load();
    } catch (e: any) {
      toast.error(`Run failed: ${e?.message || "error"}`);
    } finally { setRunning(false); }
  };

  if (loading) {
    return (
      <Card><CardContent className="p-6 text-sm text-muted-foreground flex items-center gap-2">
        <CircleDashed className="h-4 w-4 animate-spin" /> Loading auto-pool…
      </CardContent></Card>
    );
  }

  const lim = data?.limits || { interval_min: { min: 1, max: 1440 }, ttl_min: { min: 5, max: 10080 }, max_size: { min: 50, max: 500000 } };
  const lr = data?.lastResult;

  return (
    <Card className="border-white/[0.06]">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Timer className="h-4 w-4 text-primary" />
            Auto-pool scheduler
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant={form.enabled ? "default" : "secondary"}>
              {form.enabled ? "Enabled" : "Disabled"}
            </Badge>
            {data?.running && <Badge className="bg-amber-600/40">Running…</Badge>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-lg bg-white/[0.03] p-3">
          <div>
            <div className="text-sm font-medium">Auto refill + cleanup</div>
            <div className="text-xs text-muted-foreground">Scrape new numbers, prune stale, cap pool size.</div>
          </div>
          <Switch checked={form.enabled} onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: !!v }))} />
        </div>

        <div className={compact ? "grid grid-cols-3 gap-3" : "grid grid-cols-1 sm:grid-cols-3 gap-3"}>
          <div>
            <Label className="text-xs">Scrape interval (min)</Label>
            <Input type="number" min={lim.interval_min.min} max={lim.interval_min.max}
              value={form.interval_min}
              onChange={(e) => setForm((f) => ({ ...f, interval_min: Math.max(lim.interval_min.min, Math.min(lim.interval_min.max, +e.target.value || 0)) }))} />
            <div className="text-[10px] text-muted-foreground mt-1">{lim.interval_min.min}–{lim.interval_min.max}</div>
          </div>
          <div>
            <Label className="text-xs">Stale TTL (min)</Label>
            <Input type="number" min={lim.ttl_min.min} max={lim.ttl_min.max}
              value={form.ttl_min}
              onChange={(e) => setForm((f) => ({ ...f, ttl_min: Math.max(lim.ttl_min.min, Math.min(lim.ttl_min.max, +e.target.value || 0)) }))} />
            <div className="text-[10px] text-muted-foreground mt-1">Unused → released after this</div>
          </div>
          <div>
            <Label className="text-xs">Max pool size</Label>
            <Input type="number" min={lim.max_size.min} max={lim.max_size.max}
              value={form.max_size}
              onChange={(e) => setForm((f) => ({ ...f, max_size: Math.max(lim.max_size.min, Math.min(lim.max_size.max, +e.target.value || 0)) }))} />
            <div className="text-[10px] text-muted-foreground mt-1">Oldest pruned when over</div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-center text-xs">
          <div className="rounded-lg bg-white/[0.03] py-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Pool now</div>
            <div className="text-lg font-bold">{(data?.pool ?? 0).toLocaleString()}</div>
          </div>
          <div className="rounded-lg bg-white/[0.03] py-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Last run</div>
            <div className="text-sm font-medium pt-1">{fmtAgo(data?.lastRunAt)}</div>
          </div>
        </div>

        {lr && (
          <div className="text-[11px] text-muted-foreground bg-white/[0.02] rounded p-2">
            Last cycle: pool {lr.poolBefore}→{lr.poolAfter} · pruned {lr.pruned} · capped {lr.capped}
            {lr.scrapeError && <span className="text-rose-300/90"> · scrape err: {lr.scrapeError}</span>}
          </div>
        )}

        <div className="flex gap-2">
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? <CircleDashed className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
            Save
          </Button>
          <Button size="sm" variant="outline" onClick={runNow} disabled={running || !!data?.running}>
            {running ? <CircleDashed className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Play className="h-3.5 w-3.5 mr-1.5" />}
            Run cycle now
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
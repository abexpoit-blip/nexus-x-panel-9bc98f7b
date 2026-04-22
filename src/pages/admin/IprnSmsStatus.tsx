import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { api } from "@/lib/api";
import {
  RefreshCw, Power, PowerOff, Download, KeyRound, Cookie, Trash2,
  CircleCheck, CircleAlert, CircleDashed, Search,
} from "lucide-react";
import { PageHeader } from "@/components/premium/PageHeader";

function fmtAgo(ts: number | null | undefined): string {
  if (!ts) return "never";
  const sec = Math.floor(Date.now() / 1000) - ts;
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

const STATUS_CHIPS: Array<{ key: string; label: string; tone: string }> = [
  { key: "all",       label: "All",       tone: "bg-white/10" },
  { key: "pool",      label: "Pool",      tone: "bg-emerald-500/15 text-emerald-300" },
  { key: "claiming",  label: "Claiming",  tone: "bg-amber-500/15 text-amber-300" },
  { key: "active",    label: "Active",    tone: "bg-blue-500/15 text-blue-300" },
  { key: "received",  label: "OTP Recv'd", tone: "bg-violet-500/15 text-violet-300" },
  { key: "used",      label: "Used",      tone: "bg-zinc-500/15 text-zinc-300" },
  { key: "released",  label: "Released",  tone: "bg-rose-500/15 text-rose-300" },
];

export default function IprnSmsStatus() {
  const { toast } = useToast();
  const [status, setStatus] = useState<any>(null);
  const [breakdown, setBreakdown] = useState<{
    ranges: Array<{ range_name: string; count: number; disabled: number }>;
    totalPool: number; totalActive: number; totalUsed: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const [s, b] = await Promise.all([api.iprnSms.status(), api.iprnSms.poolBreakdown()]);
      setStatus(s.status);
      setBreakdown(b);
    } catch (e) {
      // silent — page may load before bot first run
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 10_000);
    return () => clearInterval(i);
  }, []);

  const action = async (label: string, fn: () => Promise<any>) => {
    setBusy(label);
    try {
      const res = await fn();
      toast({ title: label, description: res?.error || "Done" });
      await refresh();
    } catch (e: any) {
      toast({ title: `${label} failed`, description: e?.message || "Unknown error", variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const loginBadge = useMemo(() => {
    if (!status) return { label: "Unknown", icon: CircleDashed, tone: "bg-zinc-600/40" };
    if (!status.enabled) return { label: "Disabled", icon: PowerOff, tone: "bg-zinc-600/40" };
    if (!status.running) return { label: "Stopped", icon: CircleAlert, tone: "bg-rose-600/40" };
    if (!status.loggedIn) return { label: "Not logged in", icon: CircleAlert, tone: "bg-amber-600/40" };
    return { label: "Logged in", icon: CircleCheck, tone: "bg-emerald-600/40" };
  }, [status]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="IPRN-SMS Bot"
        description="panel.iprn-sms.com — Symfony JSON API + ZIP-based auto-pool. No HTML scraping."
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={refresh} disabled={loading}>
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} /> Refresh
            </Button>
            <Button size="sm" variant="outline" onClick={() => action("Force pool sync", api.iprnSms.scrapeNow)} disabled={!!busy}>
              <Download className="h-3.5 w-3.5 mr-1.5" /> Sync now
            </Button>
            <Button size="sm" variant="outline" onClick={() => action("Restart bot", api.iprnSms.restart)} disabled={!!busy}>
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Restart
            </Button>
            {status?.enabled
              ? <Button size="sm" variant="destructive" onClick={() => action("Stop bot", api.iprnSms.stop)} disabled={!!busy}><PowerOff className="h-3.5 w-3.5 mr-1.5" /> Stop</Button>
              : <Button size="sm" onClick={() => action("Start bot", api.iprnSms.start)} disabled={!!busy}><Power className="h-3.5 w-3.5 mr-1.5" /> Start</Button>}
          </div>
        }
      />

      {/* Top KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">Login</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <loginBadge.icon className="h-4 w-4" />
              <Badge className={loginBadge.tone}>{loginBadge.label}</Badge>
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              Last login: {fmtAgo(status?.lastLoginAt)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">Pool</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{status?.poolSize ?? 0}</div>
            <div className="text-xs text-muted-foreground">
              {status?.rangesScrapedTotal || breakdown?.ranges?.length || 0} ranges
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">Last sync</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-base font-medium">{fmtAgo(status?.lastNumbersScrapeAt)}</div>
            <div className="text-xs text-muted-foreground">
              every {status?.numbersIntervalSec || 600}s
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">Added (lifetime)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{status?.numbersAddedTotal ?? 0}</div>
            <div className="text-xs text-muted-foreground">
              Active: {status?.activeAssigned ?? 0} · Used: {breakdown?.totalUsed ?? 0}
            </div>
          </CardContent>
        </Card>
      </div>

      {status?.lastError && (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="py-3">
            <div className="text-sm">
              <span className="font-semibold text-amber-300">Last error</span>
              <span className="text-muted-foreground ml-1">({fmtAgo(status?.lastErrorAt)}):</span>
              <span className="ml-2">{status.lastError}</span>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <CredentialsCard onSaved={refresh} />
        <CookieSessionPanel onChanged={refresh} />
      </div>

      <RangesCard ranges={breakdown?.ranges || []} />

      <NumbersPoolTable />
    </div>
  );
}

/* ---------------------------------------------------------------- */

function CredentialsCard({ onSaved }: { onSaved: () => void }) {
  const { toast } = useToast();
  const [creds, setCreds] = useState<any>(null);
  const [form, setForm] = useState({ username: "", password: "", base_url: "", sms_type: "sms", enabled: false });
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<{ username?: string; password?: string; base_url?: string }>({});

  useEffect(() => {
    api.iprnSms.credentials().then((c) => {
      setCreds(c);
      setForm({
        username: c.username || "",
        password: "",
        base_url: c.base_url || "https://panel.iprn-sms.com",
        sms_type: c.sms_type || "sms",
        enabled: !!c.enabled,
      });
    }).catch(() => {});
  }, []);

  const save = async () => {
    // Client-side validation — block the network call if anything is off.
    const next: { username?: string; password?: string; base_url?: string } = {};
    const username = form.username.trim();
    const baseUrl = form.base_url.trim();

    if (!username) next.username = "Username is required";
    else if (username.length < 3) next.username = "Username must be at least 3 characters";

    // Password: required on first save; optional later (blank = keep existing).
    if (!creds?.password_set && !form.password) {
      next.password = "Password is required";
    } else if (form.password && form.password.length < 1) {
      next.password = "Password cannot be empty";
    }

    if (!baseUrl) {
      next.base_url = "Base URL is required";
    } else {
      try {
        const u = new URL(baseUrl);
        if (u.protocol !== "https:" && u.protocol !== "http:") {
          next.base_url = "URL must start with http:// or https://";
        }
      } catch {
        next.base_url = "Invalid URL format";
      }
    }

    setErrors(next);
    if (Object.keys(next).length > 0) {
      toast({ title: "Fix the highlighted fields", description: Object.values(next)[0], variant: "destructive" });
      return;
    }

    setSaving(true);
    try {
      await api.iprnSms.credentialsSave({
        username: username || undefined,
        password: form.password || undefined,
        base_url: baseUrl || undefined,
        sms_type: form.sms_type,
        enabled: form.enabled,
      });
      toast({ title: "Credentials saved", description: "Bot restarted with new credentials" });
      setForm((f) => ({ ...f, password: "" }));
      onSaved();
    } catch (e: any) {
      toast({ title: "Save failed", description: e?.message || "Unknown", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <KeyRound className="h-4 w-4" /> Credentials
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Label className="text-xs">Base URL</Label>
          <Input
            value={form.base_url}
            onChange={(e) => { setForm({ ...form, base_url: e.target.value }); if (errors.base_url) setErrors({ ...errors, base_url: undefined }); }}
            placeholder="https://panel.iprn-sms.com"
            aria-invalid={!!errors.base_url}
            className={errors.base_url ? "border-destructive focus-visible:ring-destructive" : ""}
          />
          {errors.base_url && <div className="text-[11px] text-destructive mt-1">{errors.base_url}</div>}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs">Username</Label>
            <Input
              value={form.username}
              onChange={(e) => { setForm({ ...form, username: e.target.value }); if (errors.username) setErrors({ ...errors, username: undefined }); }}
              placeholder="shahriyaar"
              aria-invalid={!!errors.username}
              className={errors.username ? "border-destructive focus-visible:ring-destructive" : ""}
            />
            {errors.username && <div className="text-[11px] text-destructive mt-1">{errors.username}</div>}
            <div className="text-[10px] text-muted-foreground mt-1">source: {creds?.sources?.username || "—"}</div>
          </div>
          <div>
            <Label className="text-xs">Password</Label>
            <Input
              type="password"
              value={form.password}
              onChange={(e) => { setForm({ ...form, password: e.target.value }); if (errors.password) setErrors({ ...errors, password: undefined }); }}
              placeholder={creds?.password_set ? "••••••• (leave blank to keep)" : "••••••••"}
              aria-invalid={!!errors.password}
              className={errors.password ? "border-destructive focus-visible:ring-destructive" : ""}
              autoComplete="new-password"
            />
            {errors.password && <div className="text-[11px] text-destructive mt-1">{errors.password}</div>}
            <div className="text-[10px] text-muted-foreground mt-1">source: {creds?.sources?.password || "—"}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs">SMS type</Label>
            <select className="h-9 w-full rounded-md border border-white/10 bg-background px-2 text-sm"
              value={form.sms_type} onChange={(e) => setForm({ ...form, sms_type: e.target.value })}>
              <option value="sms">sms</option>
              <option value="voice">voice</option>
            </select>
          </div>
          <div className="flex items-end">
            <div className="flex items-center gap-2 h-9">
              <Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
              <Label className="text-xs">Bot enabled</Label>
            </div>
          </div>
        </div>
        <Button size="sm" onClick={save} disabled={saving} className="w-full">
          {saving ? "Saving…" : "Save & restart bot"}
        </Button>
      </CardContent>
    </Card>
  );
}

function CookieSessionPanel({ onChanged }: { onChanged: () => void }) {
  const { toast } = useToast();
  const [meta, setMeta] = useState<{ has_cookies: boolean; count: number; saved_at: number | null; names?: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => api.iprnSms.cookies().then(setMeta).catch(() => {});
  useEffect(() => { refresh(); const i = setInterval(refresh, 15_000); return () => clearInterval(i); }, []);

  const clear = async () => {
    setBusy(true);
    try {
      await api.iprnSms.cookiesClear();
      toast({ title: "Session cleared", description: "Bot will perform a fresh login on next cycle" });
      refresh();
      onChanged();
    } catch (e: any) {
      toast({ title: "Failed", description: e?.message || "Unknown", variant: "destructive" });
    } finally { setBusy(false); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <Cookie className="h-4 w-4" /> Session cookies
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-xs text-muted-foreground">Status</div>
            <Badge className={meta?.has_cookies ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-500/15"}>
              {meta?.has_cookies ? `${meta.count} cookies stored` : "no cookies"}
            </Badge>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Saved</div>
            <div className="text-sm">{fmtAgo(meta?.saved_at || null)}</div>
          </div>
        </div>
        {meta?.names && meta.names.length > 0 && (
          <div className="text-xs text-muted-foreground">
            <span className="font-medium">Cookies:</span> {meta.names.join(", ")}
          </div>
        )}
        <Button size="sm" variant="outline" onClick={clear} disabled={busy || !meta?.has_cookies} className="w-full">
          <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Clear session & force re-login
        </Button>
        <p className="text-[11px] text-muted-foreground">
          The bot tries the saved cookie first on each cycle. If the upstream session expires, it logs in again automatically.
        </p>
      </CardContent>
    </Card>
  );
}

function RangesCard({ ranges }: { ranges: Array<{ range_name: string; count: number; disabled: number }> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Pool by range</CardTitle>
      </CardHeader>
      <CardContent>
        {ranges.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4 text-center">No ranges in pool yet — wait for first sync</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Range</TableHead>
                <TableHead className="text-right">Numbers in pool</TableHead>
                <TableHead className="w-24">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ranges.map((r) => (
                <TableRow key={r.range_name}>
                  <TableCell className="font-mono text-xs">{r.range_name}</TableCell>
                  <TableCell className="text-right font-semibold">{r.count.toLocaleString()}</TableCell>
                  <TableCell>
                    {r.disabled
                      ? <Badge className="bg-rose-500/15 text-rose-300">Disabled</Badge>
                      : <Badge className="bg-emerald-500/15 text-emerald-300">Active</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function NumbersPoolTable() {
  const [filter, setFilter] = useState("pool");
  const [q, setQ] = useState("");
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  useEffect(() => {
    const t = setTimeout(() => {
      setLoading(true);
      api.iprnSms.numbers({ status: filter, q, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
        .then(setData)
        .catch(() => setData({ rows: [], total: 0, counts: {} }))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [filter, q, page]);

  useEffect(() => { setPage(0); }, [filter, q]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Numbers (matches upstream /premium-number/my-numbers/sms)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {STATUS_CHIPS.map((c) => {
            const count = c.key === "all"
              ? Object.values(data?.counts || {}).reduce((s: number, n: any) => s + (Number(n) || 0), 0)
              : data?.counts?.[c.key] || 0;
            return (
              <button
                key={c.key}
                onClick={() => setFilter(c.key)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium border transition ${filter === c.key ? "border-white/30 " + c.tone : "border-white/10 text-muted-foreground hover:bg-white/5"}`}
              >
                {c.label} <span className="opacity-60">({count})</span>
              </button>
            );
          })}
          <div className="ml-auto relative w-64">
            <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-7 h-8" placeholder="Search phone / range / country" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Phone</TableHead>
              <TableHead>Range</TableHead>
              <TableHead>Country</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Assigned</TableHead>
              <TableHead>OTP</TableHead>
              <TableHead className="text-right">Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow><TableCell colSpan={7} className="text-center py-6 text-muted-foreground">Loading…</TableCell></TableRow>
            )}
            {!loading && (data?.rows?.length || 0) === 0 && (
              <TableRow><TableCell colSpan={7} className="text-center py-6 text-muted-foreground">No numbers</TableCell></TableRow>
            )}
            {!loading && data?.rows?.map((r: any) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono">{r.phone_number}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{r.range_name || "—"}</TableCell>
                <TableCell>{r.country_code || "—"}</TableCell>
                <TableCell>
                  <Badge className={STATUS_CHIPS.find(c => c.key === r.status)?.tone || "bg-zinc-500/15"}>
                    {r.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs">{r.username || (r.user_id ? `#${r.user_id}` : "—")}</TableCell>
                <TableCell className="font-mono">{r.otp || "—"}</TableCell>
                <TableCell className="text-right text-xs text-muted-foreground">{fmtAgo(r.allocated_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <div className="flex items-center justify-between text-xs">
          <div className="text-muted-foreground">
            {data ? `${data.offset + 1}-${Math.min(data.offset + (data.rows?.length || 0), data.total)} of ${data.total}` : "—"}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>Prev</Button>
            <Button size="sm" variant="outline"
              disabled={!data || (data.offset + (data.rows?.length || 0)) >= data.total}
              onClick={() => setPage(p => p + 1)}>Next</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

import { useEffect, useMemo, useState } from "react";
import { GlassCard } from "@/components/GlassCard";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  RefreshCw, ScrollText, Search, CheckCircle2, XCircle, Radio,
  AlertTriangle, Wallet, ChevronDown, Link2, Wifi, Clock,
} from "lucide-react";

type AuditRow = {
  id: number; ts: number; provider: string; event: string;
  user_id: number | null; allocation_id: number | null;
  phone_number: string | null; otp_code: string | null;
  rows_seen: number | null; matches_found: number | null;
  endpoint: string | null; currency: string | null; detail: string | null;
};

const EVENT_META: Record<string, { label: string; tone: string; icon: typeof Radio }> = {
  scrape_ok:   { label: "Scrape",     tone: "text-neon-cyan bg-neon-cyan/10 border-neon-cyan/30",      icon: Radio },
  scrape_fail: { label: "Scrape failed", tone: "text-destructive bg-destructive/10 border-destructive/30", icon: XCircle },
  matched:     { label: "Matched",    tone: "text-neon-amber bg-neon-amber/10 border-neon-amber/30",  icon: CheckCircle2 },
  no_match:    { label: "No match",   tone: "text-muted-foreground bg-white/[0.04] border-white/[0.1]", icon: AlertTriangle },
  credited:    { label: "Credited",   tone: "text-neon-green bg-neon-green/10 border-neon-green/30",  icon: Wallet },
};

const PROVIDERS = [
  { id: "",         label: "All providers" },
  { id: "iprn_sms", label: "IPRN-SMS" },
  { id: "iprn",     label: "IPRN" },
  { id: "ims",      label: "IMS" },
  { id: "msi",      label: "MSI" },
  { id: "numpanel", label: "NumPanel" },
  { id: "acchub",   label: "AccHub" },
];

function fmtTime(ts: number) {
  const d = new Date(ts * 1000);
  const sameDay = new Date().toDateString() === d.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return d.toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function ago(ts: number) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const AgentOtpAudit = () => {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [stats, setStats] = useState<{ scrapes: number; failures: number; matched: number; credited: number; unmatched: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState("");
  const [search, setSearch] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [intervalSec, setIntervalSec] = useState(5);
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);

  const load = async () => {
    try {
      const { rows, stats_24h } = await api.otpAudit({ limit: 200, provider: provider || undefined });
      setRows(rows);
      setStats(stats_24h);
      setLastRefresh(Math.floor(Date.now() / 1000));
    } catch {
      // silent — keep last data
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  useEffect(() => {
    if (!autoRefresh) return;
    const i = setInterval(load, intervalSec * 1000);
    return () => clearInterval(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, provider, intervalSec]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      (r.phone_number || "").toLowerCase().includes(q) ||
      (r.otp_code || "").toLowerCase().includes(q) ||
      (r.detail || "").toLowerCase().includes(q) ||
      (r.event || "").toLowerCase().includes(q) ||
      (r.endpoint || "").toLowerCase().includes(q)
    );
  }, [rows, search]);

  // Group most recent scrape events per provider for the debug panel.
  // Backend stores endpoint as a full URL with query string — we parse it
  // so agents can see exactly which date range / currency the bot used.
  const scrapeDebug = useMemo(() => {
    const seen = new Map<string, AuditRow>();
    for (const r of rows) {
      if (r.event !== "scrape_ok" && r.event !== "scrape_fail") continue;
      if (!seen.has(r.provider)) seen.set(r.provider, r);
    }
    return Array.from(seen.values()).map((r) => {
      let path = r.endpoint || "";
      const params: Array<[string, string]> = [];
      try {
        if (r.endpoint) {
          // Endpoint may be a relative path like "/api/.../sms.json?date_from=..."
          const u = new URL(r.endpoint, "https://x.local");
          path = u.pathname;
          u.searchParams.forEach((v, k) => params.push([k, v]));
        }
      } catch {
        /* ignore parse errors — show raw endpoint */
      }
      return { row: r, path, params };
    });
  }, [rows]);

  // Last 8 successfully credited OTPs — quick "did my OTP land?" panel.
  const lastCredited = useMemo(
    () => rows.filter((r) => r.event === "credited").slice(0, 8),
    [rows]
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-display font-bold text-foreground flex items-center gap-2">
            <ScrollText className="w-6 h-6 text-neon-cyan" />
            OTP Audit Log
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Live trace of every OTP scrape, match, and credit. Refreshes every {intervalSec}s.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative hidden sm:block">
            <select
              value={intervalSec}
              onChange={(e) => setIntervalSec(Number(e.target.value))}
              className="appearance-none h-9 pl-3 pr-8 rounded-md bg-white/[0.04] border border-white/[0.1] text-xs text-foreground focus:outline-none focus:border-primary/50"
              aria-label="Auto-refresh interval"
            >
              <option value={3} className="bg-[hsl(var(--card))]">Every 3s</option>
              <option value={5} className="bg-[hsl(var(--card))]">Every 5s</option>
              <option value={8} className="bg-[hsl(var(--card))]">Every 8s</option>
              <option value={15} className="bg-[hsl(var(--card))]">Every 15s</option>
              <option value={30} className="bg-[hsl(var(--card))]">Every 30s</option>
            </select>
            <ChevronDown className="w-3.5 h-3.5 absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          </div>
          {lastRefresh && (
            <span className="hidden md:inline-flex items-center gap-1 text-[11px] text-muted-foreground font-mono">
              <Clock className="w-3 h-3" />
              {ago(lastRefresh)}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAutoRefresh((v) => !v)}
            className={cn("h-9", autoRefresh && "border-neon-green/40 text-neon-green")}
          >
            <Radio className={cn("w-3.5 h-3.5 mr-1.5", autoRefresh && "animate-pulse")} />
            {autoRefresh ? "Live" : "Paused"}
          </Button>
          <Button variant="outline" size="sm" onClick={load} className="h-9">
            <RefreshCw className={cn("w-3.5 h-3.5 mr-1.5", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Stats — last 24h */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {[
          { label: "Scrapes",   value: stats?.scrapes,   tone: "text-neon-cyan",     icon: Radio },
          { label: "Matched",   value: stats?.matched,   tone: "text-neon-amber",    icon: CheckCircle2 },
          { label: "Credited",  value: stats?.credited,  tone: "text-neon-green",    icon: Wallet },
          { label: "Unmatched", value: stats?.unmatched, tone: "text-muted-foreground", icon: AlertTriangle },
          { label: "Failures",  value: stats?.failures,  tone: "text-destructive",   icon: XCircle },
        ].map((s) => {
          const Icon = s.icon;
          return (
            <GlassCard key={s.label} className="p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">{s.label}</span>
                <Icon className={cn("w-4 h-4", s.tone)} />
              </div>
              <div className={cn("text-2xl font-display font-bold mt-1", s.tone)}>
                {s.value ?? "—"}
              </div>
              <div className="text-[10px] text-muted-foreground/70 mt-0.5">last 24h</div>
            </GlassCard>
          );
        })}
      </div>

      {/* Filters */}
      <GlassCard>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 mb-4">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by phone, OTP, endpoint, detail..."
              className="w-full h-10 pl-9 pr-3 rounded-lg bg-white/[0.04] border border-white/[0.1] text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
            />
          </div>
          <div className="relative">
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="appearance-none w-full sm:w-48 h-10 pl-3 pr-9 rounded-lg bg-white/[0.04] border border-white/[0.1] text-sm text-foreground focus:outline-none focus:border-primary/50"
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id} className="bg-[hsl(var(--card))]">{p.label}</option>
              ))}
            </select>
            <ChevronDown className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          </div>
        </div>

        {loading && rows.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted-foreground">Loading audit events…</div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            {rows.length === 0
              ? "No audit events yet. Once OTPs start arriving they'll appear here in real time."
              : `No events match "${search}"`}
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((r) => {
              const meta = EVENT_META[r.event] || { label: r.event, tone: "text-foreground bg-white/[0.05] border-white/[0.1]", icon: Radio };
              const Icon = meta.icon;
              return (
                <div
                  key={r.id}
                  className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 hover:border-white/[0.12] transition-colors"
                >
                  <div className="flex items-start gap-3 flex-wrap">
                    <span className={cn("inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-md border", meta.tone)}>
                      <Icon className="w-3 h-3" />
                      {meta.label}
                    </span>
                    <span className="text-[11px] px-2 py-1 rounded-md bg-white/[0.04] border border-white/[0.08] text-muted-foreground font-mono uppercase">
                      {r.provider}
                    </span>
                    {r.currency && (
                      <span className="text-[11px] px-2 py-1 rounded-md bg-neon-amber/10 border border-neon-amber/20 text-neon-amber font-mono">
                        {r.currency}
                      </span>
                    )}
                    <div className="ml-auto text-[11px] text-muted-foreground flex items-center gap-2">
                      <span className="font-mono">{fmtTime(r.ts)}</span>
                      <span className="text-muted-foreground/60">·</span>
                      <span>{ago(r.ts)}</span>
                    </div>
                  </div>

                  {(r.phone_number || r.otp_code) && (
                    <div className="mt-2 flex items-center gap-3 flex-wrap text-sm">
                      {r.phone_number && (
                        <span className="font-mono text-foreground">{r.phone_number}</span>
                      )}
                      {r.otp_code && (
                        <>
                          <span className="text-muted-foreground/50">→</span>
                          <span className="font-mono font-bold text-neon-green tracking-wider">{r.otp_code}</span>
                        </>
                      )}
                    </div>
                  )}

                  {r.detail && (
                    <div className="mt-1.5 text-xs text-muted-foreground">{r.detail}</div>
                  )}

                  {r.event === "scrape_ok" && (
                    <div className="mt-1.5 text-[11px] text-muted-foreground/70 font-mono">
                      {r.rows_seen ?? 0} rows scraped · {r.matches_found ?? 0} matched
                    </div>
                  )}

                  {r.endpoint && (
                    <div className="mt-2 text-[10px] font-mono text-muted-foreground/60 break-all">
                      <span className="text-muted-foreground/40">endpoint:</span> {r.endpoint}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </GlassCard>
    </div>
  );
};

export default AgentOtpAudit;
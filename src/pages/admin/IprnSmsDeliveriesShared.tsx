import { useEffect, useMemo, useState } from "react";
import { GlassCard } from "@/components/GlassCard";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { OtpDeliveryRow, OtpDeliveriesResponse } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  RefreshCw, ScrollText, Search, CheckCircle2, XCircle, Radio,
  AlertTriangle, Wallet, Clock, User as UserIcon, Hash,
} from "lucide-react";

const EVENT_META: Record<string, { label: string; tone: string; icon: typeof Radio }> = {
  matched:     { label: "Matched",   tone: "text-neon-amber bg-neon-amber/10 border-neon-amber/30",    icon: CheckCircle2 },
  credited:    { label: "Credited",  tone: "text-neon-green bg-neon-green/10 border-neon-green/30",    icon: Wallet },
  no_match:    { label: "Rejected",  tone: "text-destructive bg-destructive/10 border-destructive/30", icon: XCircle },
  scrape_ok:   { label: "Scrape",    tone: "text-neon-cyan bg-neon-cyan/10 border-neon-cyan/30",       icon: Radio },
  scrape_fail: { label: "Scrape failed", tone: "text-destructive bg-destructive/10 border-destructive/30", icon: AlertTriangle },
};

const FILTERS: Array<{ id: string; label: string }> = [
  { id: "",          label: "All events" },
  { id: "credited",  label: "Credited" },
  { id: "matched",   label: "Matched" },
  { id: "no_match",  label: "Rejected" },
  { id: "scrape_fail", label: "Scrape failures" },
];

function fmtTime(ts: number) {
  const d = new Date(ts * 1000);
  const sameDay = new Date().toDateString() === d.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return d.toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function ago(ts: number) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

type Props = {
  title: string;
  description: string;
  fetcher: (params: { limit?: number; event?: string; q?: string; sinceHours?: number }) => Promise<OtpDeliveriesResponse>;
};

export default function IprnSmsDeliveriesShared({ title, description, fetcher }: Props) {
  const [rows, setRows] = useState<OtpDeliveryRow[]>([]);
  const [stats, setStats] = useState<OtpDeliveriesResponse["stats"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [event, setEvent] = useState("");
  const [search, setSearch] = useState("");
  const [sinceHours, setSinceHours] = useState(24);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const load = async () => {
    try {
      const res = await fetcher({ limit: 300, event: event || undefined, q: search || undefined, sinceHours });
      setRows(res.rows);
      setStats(res.stats);
    } catch {
      /* ignore — keep last */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, sinceHours]);

  useEffect(() => {
    if (!autoRefresh) return;
    const i = setInterval(load, 8000);
    return () => clearInterval(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, event, sinceHours, search]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      (r.phone_number || "").toLowerCase().includes(q) ||
      (r.otp_code || "").toLowerCase().includes(q) ||
      (r.agent_username || "").toLowerCase().includes(q) ||
      (r.detail || "").toLowerCase().includes(q)
    );
  }, [rows, search]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-display font-bold text-foreground flex items-center gap-2">
            <ScrollText className="w-6 h-6 text-neon-cyan" />
            {title}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{description}</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={sinceHours}
            onChange={(e) => setSinceHours(Number(e.target.value))}
            className="h-9 px-2 rounded-md bg-white/[0.04] border border-white/[0.1] text-xs text-foreground focus:outline-none focus:border-primary/50"
            aria-label="Time window"
          >
            <option value={1}  className="bg-[hsl(var(--card))]">Last 1h</option>
            <option value={6}  className="bg-[hsl(var(--card))]">Last 6h</option>
            <option value={24} className="bg-[hsl(var(--card))]">Last 24h</option>
            <option value={72} className="bg-[hsl(var(--card))]">Last 3d</option>
            <option value={168} className="bg-[hsl(var(--card))]">Last 7d</option>
          </select>
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

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {[
          { label: "Scraped",  value: stats?.scraped,  tone: "text-neon-cyan",        icon: Radio },
          { label: "Matched",  value: stats?.matched,  tone: "text-neon-amber",       icon: CheckCircle2 },
          { label: "Credited", value: stats?.credited, tone: "text-neon-green",       icon: Wallet },
          { label: "Rejected", value: stats?.rejected, tone: "text-destructive",      icon: XCircle },
          { label: "Failures", value: stats?.failures, tone: "text-muted-foreground", icon: AlertTriangle },
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
              <div className="text-[10px] text-muted-foreground/70 mt-0.5">window selected</div>
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
              placeholder="Search by phone, OTP, agent, detail..."
              className="w-full h-10 pl-9 pr-3 rounded-lg bg-white/[0.04] border border-white/[0.1] text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.id || "all"}
                onClick={() => setEvent(f.id)}
                className={cn(
                  "h-10 px-3 rounded-lg text-xs font-semibold border transition-colors",
                  event === f.id
                    ? "bg-primary/15 border-primary/40 text-primary"
                    : "bg-white/[0.04] border-white/[0.1] text-muted-foreground hover:text-foreground"
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {loading && rows.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted-foreground">Loading delivery feed…</div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            {rows.length === 0
              ? "No OTP delivery events in this window yet."
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
                    {r.currency && (
                      <span className="text-[11px] px-2 py-1 rounded-md bg-neon-amber/10 border border-neon-amber/20 text-neon-amber font-mono">
                        {r.currency}
                      </span>
                    )}
                    {r.allocation_status && (
                      <span className="text-[11px] px-2 py-1 rounded-md bg-white/[0.04] border border-white/[0.08] text-muted-foreground font-mono uppercase">
                        alloc: {r.allocation_status}
                      </span>
                    )}
                    <div className="ml-auto text-[11px] text-muted-foreground flex items-center gap-2">
                      <Clock className="w-3 h-3" />
                      <span className="font-mono">{fmtTime(r.ts)}</span>
                      <span className="text-muted-foreground/60">·</span>
                      <span>{ago(r.ts)} ago</span>
                    </div>
                  </div>

                  <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-[12px]">
                    {r.phone_number && (
                      <div className="flex items-center gap-1.5 font-mono text-foreground/90">
                        <Hash className="w-3 h-3 text-muted-foreground" />
                        {r.phone_number}
                      </div>
                    )}
                    {r.otp_code && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-muted-foreground text-[10px] uppercase">OTP</span>
                        <span className="font-mono font-bold text-neon-green tracking-wider">{r.otp_code}</span>
                      </div>
                    )}
                    {r.agent_username && (
                      <div className="flex items-center gap-1.5 text-foreground/90">
                        <UserIcon className="w-3 h-3 text-muted-foreground" />
                        <span className="font-mono">{r.agent_username}</span>
                      </div>
                    )}
                    {r.allocation_range && (
                      <div className="text-muted-foreground truncate">
                        <span className="text-[10px] uppercase">range</span>{" "}
                        <span className="text-foreground/80">{r.allocation_range}</span>
                      </div>
                    )}
                  </div>

                  {r.detail && (
                    <div className="mt-1.5 text-[11px] text-muted-foreground/90">{r.detail}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </GlassCard>
    </div>
  );
}
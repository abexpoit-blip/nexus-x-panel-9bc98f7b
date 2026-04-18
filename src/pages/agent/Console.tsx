import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { GlassCard } from "@/components/GlassCard";
import { Input } from "@/components/ui/input";
import { Search, RefreshCw, Inbox, Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";

// Shorten IMS range names like "Peru Bitel TF04" → "TF04"
const shortRange = (operator?: string | null) => {
  if (!operator) return "";
  const parts = operator.trim().split(/\s+/);
  return parts[parts.length - 1] || operator;
};

// PUBLIC OTP activity feed — every agent sees the same masked stream so they
// can spot which ranges are actively receiving OTPs and pick winners in Get
// Number. Phone digits and OTP codes are masked server-side; nobody can see
// another agent's actual code from here.
const AgentConsole = () => {
  const { data, refetch, isFetching } = useQuery({
    queryKey: ["public-otp-feed"],
    queryFn: () => api.cdr.feed(),
    refetchInterval: 5000,
  });
  const [search, setSearch] = useState("");

  const items = useMemo(() => {
    const feed = data?.feed || [];
    if (!search) return feed;
    const q = search.toLowerCase();
    return feed.filter((c) =>
      c.phone_masked.toLowerCase().includes(q) ||
      (c.operator || "").toLowerCase().includes(q) ||
      (c.country_code || "").toLowerCase().includes(q)
    );
  }, [data, search]);

  // Count OTPs per range (short label) in the last 1 hour — agents instantly
  // see which range is hottest right now. Sorted desc, top 8 shown as chips.
  const hotRanges = useMemo(() => {
    const feed = data?.feed || [];
    const cutoff = Math.floor(Date.now() / 1000) - 3600;
    const counts = new Map<string, { count: number; isIms: boolean }>();
    for (const c of feed) {
      if (c.created_at < cutoff) continue;
      const isIms = c.provider === "ims";
      const key = isIms ? shortRange(c.operator) : (c.operator || c.country_code || "—");
      if (!key) continue;
      const cur = counts.get(key) || { count: 0, isIms };
      cur.count += 1;
      counts.set(key, cur);
    }
    return Array.from(counts.entries())
      .map(([label, v]) => ({ label, ...v }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  }, [data]);

  const countFor = (label: string) =>
    hotRanges.find((r) => r.label === label)?.count || 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-bold text-foreground flex items-center gap-2">
            <Activity className="w-6 h-6 text-primary" /> Live OTP Activity
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Public feed of every OTP delivered across the platform. Numbers and codes are masked —
            use this to spot which ranges are <span className="text-neon-green">hot</span> right now.
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="flex items-center gap-2 px-4 py-2 glass rounded-lg text-sm text-muted-foreground hover:text-primary transition-colors"
        >
          <RefreshCw className={cn("w-4 h-4", isFetching && "animate-spin")} />
          Refresh
        </button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by range, operator, or country..."
          className="pl-10 bg-white/[0.04] border-white/[0.1] h-11"
        />
      </div>

      {hotRanges.length > 0 && (
        <GlassCard className="!p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">🔥 Hot ranges · last 1h</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {hotRanges.map((r, idx) => (
              <button
                key={r.label}
                onClick={() => setSearch(r.label)}
                className={cn(
                  "flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold transition-all",
                  idx === 0
                    ? "bg-neon-green/15 text-neon-green border border-neon-green/40"
                    : r.isIms
                      ? "bg-neon-magenta/10 text-neon-magenta hover:bg-neon-magenta/20"
                      : "bg-neon-cyan/10 text-neon-cyan hover:bg-neon-cyan/20"
                )}
                title={`Filter feed by ${r.label}`}
              >
                <span>{r.label}</span>
                <span className="px-1.5 py-0.5 rounded-full bg-background/40 font-mono">{r.count}</span>
              </button>
            ))}
          </div>
        </GlassCard>
      )}

      <div className="space-y-3">
        {items.map((c) => {
          const isIms = c.provider === "ims";
          const label = isIms ? shortRange(c.operator) : (c.operator || c.country_code || "—");
          const fullDetail = isIms
            ? (c.operator || label)
            : [c.operator, c.country_code].filter(Boolean).join(" · ");
          const labelStyle = isIms
            ? "bg-neon-magenta/10 text-neon-magenta"
            : "bg-neon-cyan/10 text-neon-cyan";
          const otpMask = "X".repeat(c.otp_length || 6);
          const hotCount = countFor(label);
          return (
            <GlassCard key={c.id} className="!p-4 hover:neon-border-cyan transition-all">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-mono text-primary">{c.phone_masked}</span>
                    <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-semibold", labelStyle)}>
                      {label}
                    </span>
                    {hotCount >= 2 && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-neon-green/10 text-neon-green">
                        🔥 {hotCount} in 1h
                      </span>
                    )}
                  </div>
                  {fullDetail && (
                    <p className="mt-1 text-xs text-muted-foreground truncate">{fullDetail}</p>
                  )}
                  <p className="mt-2 text-base text-foreground leading-relaxed font-mono tracking-widest">
                    OTP:{" "}
                    <span className="font-bold text-muted-foreground/70">{otpMask}</span>
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs text-muted-foreground">{new Date(c.created_at * 1000).toLocaleTimeString()}</p>
                  <p className="text-[10px] text-muted-foreground/70">{new Date(c.created_at * 1000).toLocaleDateString()}</p>
                </div>
              </div>
            </GlassCard>
          );
        })}
        {items.length === 0 && (
          <div className="text-center py-16 text-muted-foreground">
            <Inbox className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="text-sm">No OTP activity yet — once any agent receives an OTP it will appear here.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default AgentConsole;

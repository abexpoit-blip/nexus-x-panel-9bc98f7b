import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { GlassCard } from "@/components/GlassCard";
import { useAuth } from "@/contexts/AuthContext";
import { Trophy, Medal, Hash, Wallet, Crown, Award, Star } from "lucide-react";
import { cn } from "@/lib/utils";

// Tiered badge based on total OTPs delivered
const tierFor = (otp: number) => {
  if (otp >= 1000) return { label: "Diamond", className: "bg-neon-cyan/15 text-neon-cyan border-neon-cyan/30", icon: Crown };
  if (otp >= 500) return { label: "Platinum", className: "bg-neon-magenta/15 text-neon-magenta border-neon-magenta/30", icon: Award };
  if (otp >= 200) return { label: "Gold", className: "bg-neon-amber/15 text-neon-amber border-neon-amber/30", icon: Star };
  if (otp >= 50) return { label: "Silver", className: "bg-muted-foreground/15 text-muted-foreground border-muted-foreground/30", icon: Star };
  if (otp >= 10) return { label: "Bronze", className: "bg-orange-500/15 text-orange-400 border-orange-500/30", icon: Star };
  return { label: "Rookie", className: "bg-white/[0.04] text-muted-foreground/60 border-white/[0.06]", icon: Star };
};

const AgentLeaderboard = () => {
  const { user } = useAuth();
  const { data, isLoading } = useQuery({ queryKey: ["leaderboard"], queryFn: () => api.admin.leaderboard(), refetchInterval: 60000 });
  const rows = data?.leaderboard || [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-display font-bold text-foreground flex items-center gap-2">
          <Trophy className="w-7 h-7 text-neon-amber" /> Leaderboard
        </h1>
        <p className="text-sm text-muted-foreground mt-1">Top agents ranked by total OTPs delivered · with tier badges</p>
      </div>

      <GlassCard className="p-2">
        <div className="space-y-1">
          {rows.map((r, i) => {
            const isMe = r.id === user?.id;
            const medal = i === 0 ? "text-neon-amber" : i === 1 ? "text-muted-foreground" : i === 2 ? "text-orange-400" : "text-muted-foreground/40";
            const tier = tierFor(r.otp_count);
            const TierIcon = tier.icon;
            const successRate = r.numbers_used && r.numbers_used > 0
              ? Math.round((r.otp_count / r.numbers_used) * 100)
              : 0;
            return (
              <div
                key={r.id}
                className={cn(
                  "flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-lg transition-colors",
                  isMe ? "bg-primary/10 border border-primary/30" : "hover:bg-white/[0.03]"
                )}
              >
                <div className="flex items-center gap-4 min-w-0 flex-1">
                  <div className="w-10 text-center shrink-0">
                    {i < 3 ? <Medal className={cn("w-6 h-6 mx-auto", medal)} /> : <span className="font-mono text-muted-foreground">{i + 1}</span>}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-foreground truncate">
                        {r.username} {isMe && <span className="text-xs text-primary ml-1">(You)</span>}
                      </p>
                      <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border", tier.className)}>
                        <TierIcon className="w-3 h-3" /> {tier.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Hash className="w-3 h-3" /> {(r.numbers_used ?? 0).toLocaleString()} numbers used
                      </span>
                      {(r.earnings_bdt ?? 0) > 0 && (
                        <span className="inline-flex items-center gap-1 text-neon-green">
                          <Wallet className="w-3 h-3" /> ৳{(+(r.earnings_bdt ?? 0)).toFixed(0)}
                        </span>
                      )}
                      {successRate > 0 && (
                        <span className="hidden sm:inline">
                          {successRate}% success
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="text-right shrink-0 pl-12 sm:pl-0">
                  <p className="text-xl font-display font-bold text-foreground">{r.otp_count.toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">OTPs</p>
                </div>
              </div>
            );
          })}
          {!rows.length && !isLoading && <p className="text-center text-muted-foreground py-12 text-sm">No data yet</p>}
        </div>
      </GlassCard>
    </div>
  );
};

export default AgentLeaderboard;

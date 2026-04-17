import { Hash, MessageSquare, TrendingUp, Wallet, Activity, Clock, Target } from "lucide-react";
import { StatCard } from "@/components/StatCard";
import { GlassCard } from "@/components/GlassCard";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { OtpLine, SuccessGauge } from "@/components/charts/Charts";
import { useMemo } from "react";

const AgentDashboard = () => {
  const { user } = useAuth();
  const { data: summary } = useQuery({ queryKey: ["summary"], queryFn: () => api.numberSummary(), refetchInterval: 15000 });
  const { data: nums } = useQuery({ queryKey: ["my-numbers"], queryFn: () => api.myNumbers(), refetchInterval: 10000 });

  const s = summary || { today: { c: 0, s: 0 }, week: { c: 0, s: 0 }, month: { c: 0, s: 0 }, active: 0 };
  const recent = (nums?.numbers || []).slice(0, 8);
  const allNums = nums?.numbers || [];

  // Build 7-day OTP delivery series from my numbers
  const otpSeries = useMemo(() => {
    const days = 7;
    const buckets: Record<string, number> = {};
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      buckets[d.toISOString().slice(5, 10)] = 0;
    }
    allNums.forEach((n: any) => {
      if (!n.otp_received_at) return;
      const key = new Date(n.otp_received_at * 1000).toISOString().slice(5, 10);
      if (buckets[key] !== undefined) buckets[key] += 1;
    });
    return Object.entries(buckets).map(([label, value]) => ({ label, value }));
  }, [allNums]);

  // OTP success rate = received / total allocations (capped to 100)
  const totalAllocations = allNums.length;
  const receivedCount = allNums.filter((n: any) => n.otp).length;
  const successRate = totalAllocations > 0 ? (receivedCount / totalAllocations) * 100 : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <motion.h1 initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} className="text-3xl font-display font-bold text-foreground">
            Welcome, <span className="text-glow-cyan text-primary">{user?.username}</span>
          </motion.h1>
          <p className="text-sm text-muted-foreground mt-1">Live performance — auto refreshes every 15 seconds</p>
        </div>
        <div className="flex items-center gap-2 px-3 py-2 glass rounded-xl">
          <div className="w-2 h-2 rounded-full bg-neon-green animate-pulse" />
          <span className="text-xs text-muted-foreground">Live</span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard label="Active Numbers" value={s.active} icon={Hash} color="cyan" />
        <StatCard label="Today OTP" value={s.today.c} icon={MessageSquare} color="magenta" />
        <StatCard label="7-Day OTP" value={s.week.c} icon={TrendingUp} color="green" />
        <StatCard label="Earnings (Withdrawable)" value={`৳${user?.balance.toFixed(2) || "0.00"}`} icon={Wallet} color="amber" />
      </div>

      <p className="text-xs text-muted-foreground -mt-2">
        💡 Numbers are <span className="text-neon-green font-semibold">100% free</span> — you only earn when an OTP is successfully received. No balance is deducted to get a number.
      </p>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <GlassCard glow="magenta" className="lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-display font-semibold text-foreground flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-neon-magenta" /> OTP delivery (last 7 days)
            </h3>
            <span className="text-xs text-muted-foreground">count</span>
          </div>
          <OtpLine data={otpSeries} height={240} />
        </GlassCard>

        <GlassCard glow="cyan">
          <h3 className="font-display font-semibold text-foreground mb-2 flex items-center gap-2">
            <Target className="w-4 h-4 text-neon-green" /> Success Rate
          </h3>
          <SuccessGauge value={successRate} label="OTP Received" />
          <div className="mt-3 pt-3 border-t border-white/[0.04] text-xs grid grid-cols-2 gap-2">
            <div><span className="text-muted-foreground">Received</span><p className="font-mono text-neon-green text-base">{receivedCount}</p></div>
            <div><span className="text-muted-foreground">Total</span><p className="font-mono text-foreground text-base">{totalAllocations}</p></div>
          </div>
        </GlassCard>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <GlassCard className="lg:col-span-2 p-6">
          <h3 className="font-display font-semibold text-foreground mb-4 flex items-center gap-2">
            <Clock className="w-4 h-4 text-primary" /> Recent Numbers
          </h3>
          {!recent.length && <p className="text-sm text-muted-foreground/60 text-center py-12">No activity yet — go to Get Number to start</p>}
          <div className="space-y-2">
            {recent.map((item) => (
              <div key={item.id} className="flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-white/[0.02] border-b border-white/[0.04] last:border-0">
                <div className="flex items-center gap-3">
                  <span className={cn("w-2 h-2 rounded-full",
                    item.status === "received" ? "bg-neon-green" : item.status === "active" ? "bg-neon-amber animate-pulse" : "bg-muted-foreground"
                  )} />
                  <div>
                    <p className="text-sm font-mono text-foreground">{item.phone_number}</p>
                    <p className="text-xs text-muted-foreground">{item.operator || "—"}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className={cn("text-sm font-mono",
                    item.otp ? "text-neon-green" : "text-muted-foreground"
                  )}>{item.otp || "waiting…"}</p>
                  <p className="text-xs text-muted-foreground">{new Date(item.allocated_at * 1000).toLocaleTimeString()}</p>
                </div>
              </div>
            ))}
          </div>
        </GlassCard>

        <GlassCard className="p-6">
          <h3 className="font-display font-semibold text-foreground mb-4 flex items-center gap-2">
            <Activity className="w-4 h-4 text-neon-amber" /> Earnings This Period
          </h3>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Today earned</span><span className="font-bold text-neon-green">+৳{s.today.s.toFixed(2)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">7-day earned</span><span className="font-bold text-neon-green">+৳{s.week.s.toFixed(2)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">30-day earned</span><span className="font-bold text-neon-green">+৳{s.month.s.toFixed(2)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">30-day OTPs</span><span className="font-bold">{s.month.c}</span></div>
          </div>
        </GlassCard>
      </div>
    </div>
  );
};

export default AgentDashboard;

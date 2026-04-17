import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { StatCard } from "@/components/StatCard";
import { GlassCard } from "@/components/GlassCard";
import { TrendingUp, MessageSquare, Calendar, Wallet } from "lucide-react";

const AgentSummary = () => {
  const { data } = useQuery({ queryKey: ["summary"], queryFn: () => api.numberSummary(), refetchInterval: 30000 });
  const { data: cdr } = useQuery({ queryKey: ["my-cdr"], queryFn: () => api.cdr.mine() });

  const s = data || { today: { c: 0, s: 0 }, week: { c: 0, s: 0 }, month: { c: 0, s: 0 }, active: 0 };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-display font-bold text-foreground flex items-center gap-2">
          <TrendingUp className="w-7 h-7 text-primary" /> Summary
        </h1>
        <p className="text-sm text-muted-foreground mt-1">Your OTP performance and earnings overview</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard label="Today OTP" value={s.today.c} icon={MessageSquare} color="cyan" />
        <StatCard label="Today Earned" value={`৳${s.today.s.toFixed(2)}`} icon={Wallet} color="green" />
        <StatCard label="7-Day OTP" value={s.week.c} icon={Calendar} color="amber" />
        <StatCard label="30-Day OTP" value={s.month.c} icon={TrendingUp} color="magenta" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <GlassCard>
          <h3 className="font-display font-semibold mb-4">Period Breakdown</h3>
          <div className="space-y-3 text-sm">
            <Row label="Today" otp={s.today.c} earned={s.today.s} />
            <Row label="Last 7 Days" otp={s.week.c} earned={s.week.s} />
            <Row label="Last 30 Days" otp={s.month.c} earned={s.month.s} />
          </div>
        </GlassCard>
        <GlassCard>
          <h3 className="font-display font-semibold mb-4">Recent Successful OTPs</h3>
          <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
            {(cdr?.cdr || []).slice(0, 12).map((c) => (
              <div key={c.id} className="flex items-center justify-between py-2 border-b border-white/[0.04] last:border-0 text-sm">
                <div>
                  <p className="font-mono text-foreground">{c.phone_number}</p>
                  <p className="text-xs text-muted-foreground">{new Date(c.created_at * 1000).toLocaleString()}</p>
                </div>
                <div className="text-right">
                  <p className="font-bold text-neon-green">+৳{c.price_bdt.toFixed(2)}</p>
                  <p className="text-xs uppercase text-muted-foreground">{c.status}</p>
                </div>
              </div>
            ))}
            {!(cdr?.cdr || []).length && <p className="text-center text-muted-foreground text-sm py-8">No earnings yet</p>}
          </div>
        </GlassCard>
      </div>
    </div>
  );
};

const Row = ({ label, otp, earned }: { label: string; otp: number; earned: number }) => (
  <div className="flex items-center justify-between py-2 border-b border-white/[0.04] last:border-0">
    <span className="text-muted-foreground">{label}</span>
    <div className="flex gap-6">
      <span><span className="text-muted-foreground text-xs mr-1">OTP</span><span className="font-bold">{otp}</span></span>
      <span><span className="text-muted-foreground text-xs mr-1">Earned</span><span className="font-bold text-neon-green">৳{earned.toFixed(2)}</span></span>
    </div>
  </div>
);

export default AgentSummary;

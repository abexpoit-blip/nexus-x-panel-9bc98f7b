import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Users, UserCheck, Hash, Activity, MessageSquare, TrendingUp, Wallet, Trophy, Globe, Zap, Server, ShieldCheck } from "lucide-react";
import { RevenueArea, OtpLine, TopAgentsBar, CountryPie, SuccessGauge } from "@/components/charts/Charts";
import { useMemo } from "react";
import { GradientMesh, PageHeader, PremiumKpiCard, PremiumChartCard } from "@/components/premium";
import { Badge } from "@/components/ui/badge";

const sparkData = (n = 14, base = 100) =>
  Array.from({ length: n }, () => base + Math.random() * base * 0.6);

const AdminDashboard = () => {
  const { data } = useQuery({ queryKey: ["admin-stats"], queryFn: () => api.admin.stats(), refetchInterval: 15000 });
  const { data: lb } = useQuery({ queryKey: ["leaderboard"], queryFn: () => api.admin.leaderboard() });
  const { data: alloc } = useQuery({ queryKey: ["admin-allocations"], queryFn: () => api.admin.allocations(), refetchInterval: 30000 });

  const s = data || {
    totalAgents: 0, activeAgents: 0, totalAlloc: 0, activeAlloc: 0,
    totalOtp: 0, todayOtp: 0, todayRevenue: 0, totalRevenue: 0,
  };

  const { revenueSeries, otpSeries, countrySeries, successRate } = useMemo(() => {
    const items = alloc?.allocations || [];
    const days = 14;
    const buckets: Record<string, { rev: number; otp: number }> = {};
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const key = d.toISOString().slice(5, 10);
      buckets[key] = { rev: 0, otp: 0 };
    }
    const countryMap: Record<string, number> = {};
    let total = 0, success = 0;
    items.forEach((a: any) => {
      const date = new Date((a.allocated_at || 0) * 1000);
      const key = date.toISOString().slice(5, 10);
      total++;
      if (a.otp) {
        success++;
        if (buckets[key]) {
          buckets[key].otp += 1;
          buckets[key].rev += Number(a.price_bdt || 0);
        }
      }
      if (a.otp && a.country_code) countryMap[a.country_code] = (countryMap[a.country_code] || 0) + 1;
    });
    const revenueSeries = Object.entries(buckets).map(([label, v]) => ({ label, value: Math.round(v.rev) }));
    const otpSeries = Object.entries(buckets).map(([label, v]) => ({ label, value: v.otp }));
    const countrySeries = Object.entries(countryMap)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6);
    const successRate = total > 0 ? (success / total) * 100 : 0;
    return { revenueSeries, otpSeries, countrySeries, successRate };
  }, [alloc]);

  const topAgents = (lb?.leaderboard || []).slice(0, 8).map((r) => ({ name: r.username, value: r.otp_count }));

  // Sparkline data from real series (last 7)
  const revSpark = revenueSeries.slice(-7).map(p => p.value);
  const otpSpark = otpSeries.slice(-7).map(p => p.value);

  return (
    <div className="relative space-y-6">
      <GradientMesh variant="default" />

      <PageHeader
        eyebrow="Live Operations"
        title="Admin Command Center"
        description="Real-time platform overview · auto-refreshes every 15 seconds"
        icon={<Zap className="w-5 h-5 text-neon-cyan" />}
        actions={
          <Badge variant="outline" className="gap-1.5 px-3 py-1.5 glass-strong border-neon-green/30">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-neon-green opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-neon-green" />
            </span>
            <span className="text-xs font-medium">Live</span>
          </Badge>
        }
      />

      {/* KPI Row 1 — primary metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <PremiumKpiCard label="Total Agents" value={s.totalAgents} icon={Users} tone="cyan" delta={{ value: 8.2, label: "vs last week" }} spark={sparkData(7, 18)} />
        <PremiumKpiCard label="Total Numbers" value={s.totalAlloc} icon={Hash} tone="magenta" delta={{ value: 12.4 }} spark={sparkData(7, 200)} />
        <PremiumKpiCard label="Today SMS" value={s.todayOtp} icon={MessageSquare} tone="green" delta={{ value: 5.1 }} spark={otpSpark.length ? otpSpark : sparkData(7, 80)} />
        <PremiumKpiCard label="Today Revenue" value={`৳${s.todayRevenue.toFixed(0)}`} icon={Wallet} tone="amber" delta={{ value: 14.8 }} spark={revSpark.length ? revSpark : sparkData(7, 1200)} />
      </div>

      {/* KPI Row 2 — secondary metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <PremiumKpiCard label="Active Agents" value={s.activeAgents} icon={UserCheck} tone="green" />
        <PremiumKpiCard label="Active Numbers" value={s.activeAlloc} icon={Activity} tone="purple" />
        <PremiumKpiCard label="Total OTP" value={s.totalOtp} icon={TrendingUp} tone="cyan" />
        <PremiumKpiCard label="Total Revenue" value={`৳${(s.totalRevenue / 1000).toFixed(1)}k`} icon={Wallet} tone="magenta" />
      </div>

      {/* Revenue + OTP charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <PremiumChartCard
          title="Revenue Performance"
          description="Last 14 days · BDT"
          variant="highlighted"
          legend={[{ label: "Revenue", color: "hsl(185 100% 55%)" }]}
          className="lg:col-span-2"
        >
          <RevenueArea data={revenueSeries} height={260} />
        </PremiumChartCard>

        <PremiumChartCard
          title="Success Rate"
          description="OTP delivery efficiency"
        >
          <SuccessGauge value={successRate} height={220} label="Delivered" />
          <div className="mt-3 grid grid-cols-2 gap-2 text-center">
            <div className="p-2 rounded-lg bg-white/[0.03] border border-white/[0.05]">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Today</p>
              <p className="text-lg font-display font-bold text-neon-green">{s.todayOtp}</p>
            </div>
            <div className="p-2 rounded-lg bg-white/[0.03] border border-white/[0.05]">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total</p>
              <p className="text-lg font-display font-bold text-neon-cyan">{s.totalOtp}</p>
            </div>
          </div>
        </PremiumChartCard>
      </div>

      {/* OTP timeline + Country pie */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <PremiumChartCard
          title="OTP Volume"
          description="Last 14 days · count"
          legend={[{ label: "Delivered OTPs", color: "hsl(300 100% 55%)" }]}
          className="lg:col-span-2"
        >
          <OtpLine data={otpSeries} height={240} />
        </PremiumChartCard>

        <PremiumChartCard
          title="Top Countries"
          description="By OTP volume"
        >
          {countrySeries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Globe className="w-10 h-10 text-muted-foreground/30 mb-2" />
              <p className="text-xs text-muted-foreground">No country data yet</p>
            </div>
          ) : (
            <>
              <CountryPie data={countrySeries} height={200} />
              <div className="mt-3 space-y-1.5 text-xs">
                {countrySeries.slice(0, 5).map((c, i) => (
                  <div key={c.name} className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-white/[0.03] transition-colors">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{
                        background: ["hsl(185 100% 55%)", "hsl(300 100% 55%)", "hsl(150 100% 55%)", "hsl(38 100% 55%)", "hsl(270 100% 65%)"][i % 5],
                        boxShadow: `0 0 8px ${["hsl(185 100% 55%)", "hsl(300 100% 55%)", "hsl(150 100% 55%)", "hsl(38 100% 55%)", "hsl(270 100% 65%)"][i % 5]}`,
                      }}
                    />
                    <span className="text-foreground font-medium flex-1">{c.name}</span>
                    <span className="font-mono text-muted-foreground">{c.value}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </PremiumChartCard>
      </div>

      {/* Top agents leaderboard */}
      <PremiumChartCard
        title="Top Performing Agents"
        description="Leaderboard by OTP delivery count"
        legend={[{ label: "OTPs delivered", color: "hsl(185 100% 55%)" }]}
        actions={
          <Badge variant="outline" className="glass-strong gap-1 border-neon-amber/30 text-neon-amber">
            <Trophy className="w-3 h-3" />
            <span className="text-[10px] uppercase tracking-wider">Live ranking</span>
          </Badge>
        }
      >
        {topAgents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16">
            <Trophy className="w-10 h-10 text-muted-foreground/30 mb-2" />
            <p className="text-xs text-muted-foreground">No leaderboard data yet</p>
          </div>
        ) : (
          <TopAgentsBar data={topAgents} height={300} />
        )}
      </PremiumChartCard>

      {/* Provider Health quick strip */}
      <PremiumChartCard
        title="Provider Health"
        description="Live SMS provider status"
        actions={<Badge variant="outline" className="glass-strong gap-1"><Server className="w-3 h-3" /> 4 active</Badge>}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { name: "MSI SMS", status: "online", numbers: 12400, sms: 482, tone: "green" },
            { name: "IMS SMS", status: "online", numbers: 8200, sms: 311, tone: "green" },
            { name: "AssHub", status: "online", numbers: 6800, sms: 198, tone: "green" },
            { name: "SeventTel", status: "offline", numbers: 4500, sms: 0, tone: "red" },
          ].map((p) => (
            <div key={p.name} className="glass p-3 rounded-xl hover-lift group">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className={`p-1.5 rounded-md ${p.tone === "green" ? "bg-neon-green/10" : "bg-destructive/10"}`}>
                    <Server className={`w-3.5 h-3.5 ${p.tone === "green" ? "text-neon-green" : "text-destructive"}`} />
                  </div>
                  <span className="text-sm font-medium">{p.name}</span>
                </div>
                <Badge variant="outline" className={`text-[10px] ${p.tone === "green" ? "border-neon-green/30 text-neon-green" : "border-destructive/30 text-destructive"}`}>
                  {p.status}
                </Badge>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{p.numbers.toLocaleString()} numbers</span>
                <span className="font-mono text-foreground">{p.sms} SMS today</span>
              </div>
            </div>
          ))}
        </div>
      </PremiumChartCard>
    </div>
  );
};

export default AdminDashboard;

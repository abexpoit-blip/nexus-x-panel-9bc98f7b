import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, BarChart, Bar, PieChart, Pie, Cell, LineChart, Line, RadialBarChart, RadialBar, PolarAngleAxis } from "recharts";
import { cn } from "@/lib/utils";

/* Reusable tooltip styled to match the dark glass theme */
const ChartTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="glass-strong px-3 py-2 text-xs space-y-1">
      {label !== undefined && <p className="text-muted-foreground">{label}</p>}
      {payload.map((p: any, i: number) => (
        <p key={i} className="font-mono" style={{ color: p.color }}>
          <span className="text-muted-foreground mr-2">{p.name}:</span>
          {typeof p.value === "number" ? p.value.toLocaleString() : p.value}
        </p>
      ))}
    </div>
  );
};

interface SeriesPoint { label: string; value: number; }
interface RevenueLineProps { data: SeriesPoint[]; height?: number; color?: string; }

export const RevenueArea = ({ data, height = 220 }: RevenueLineProps) => (
  <ResponsiveContainer width="100%" height={height}>
    <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
      <defs>
        <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(185 100% 50%)" stopOpacity={0.5} />
          <stop offset="100%" stopColor="hsl(185 100% 50%)" stopOpacity={0} />
        </linearGradient>
      </defs>
      <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 10% 18%)" vertical={false} />
      <XAxis dataKey="label" stroke="hsl(215 20% 55%)" fontSize={11} tickLine={false} axisLine={false} />
      <YAxis stroke="hsl(215 20% 55%)" fontSize={11} tickLine={false} axisLine={false} />
      <Tooltip content={<ChartTooltip />} cursor={{ stroke: "hsl(185 100% 50% / 0.3)" }} />
      <Area type="monotone" dataKey="value" stroke="hsl(185 100% 50%)" strokeWidth={2} fill="url(#revGrad)" />
    </AreaChart>
  </ResponsiveContainer>
);

export const CommissionArea = ({ data, height = 240 }: RevenueLineProps) => (
  <ResponsiveContainer width="100%" height={height}>
    <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
      <defs>
        <linearGradient id="commGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(300 100% 55%)" stopOpacity={0.55} />
          <stop offset="100%" stopColor="hsl(300 100% 55%)" stopOpacity={0} />
        </linearGradient>
      </defs>
      <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 10% 18%)" vertical={false} />
      <XAxis dataKey="label" stroke="hsl(215 20% 55%)" fontSize={11} tickLine={false} axisLine={false} />
      <YAxis stroke="hsl(215 20% 55%)" fontSize={11} tickLine={false} axisLine={false}
        tickFormatter={(v) => `৳${v >= 1000 ? (v / 1000).toFixed(1) + "k" : v}`} />
      <Tooltip content={<ChartTooltip />} cursor={{ stroke: "hsl(300 100% 55% / 0.3)" }} />
      <Area type="monotone" dataKey="value" name="Commission" stroke="hsl(300 100% 55%)" strokeWidth={2} fill="url(#commGrad)" />
    </AreaChart>
  </ResponsiveContainer>
);

export const OtpLine = ({ data, height = 220 }: RevenueLineProps) => (
  <ResponsiveContainer width="100%" height={height}>
    <LineChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
      <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 10% 18%)" vertical={false} />
      <XAxis dataKey="label" stroke="hsl(215 20% 55%)" fontSize={11} tickLine={false} axisLine={false} />
      <YAxis stroke="hsl(215 20% 55%)" fontSize={11} tickLine={false} axisLine={false} />
      <Tooltip content={<ChartTooltip />} cursor={{ stroke: "hsl(300 100% 45% / 0.3)" }} />
      <Line type="monotone" dataKey="value" stroke="hsl(300 100% 45%)" strokeWidth={2.5} dot={false} />
    </LineChart>
  </ResponsiveContainer>
);

interface BarItem { name: string; value: number; }
export const TopAgentsBar = ({ data, height = 260 }: { data: BarItem[]; height?: number }) => (
  <ResponsiveContainer width="100%" height={height}>
    <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
      <defs>
        <linearGradient id="barGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="hsl(185 100% 50%)" />
          <stop offset="100%" stopColor="hsl(300 100% 45%)" />
        </linearGradient>
      </defs>
      <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 10% 18%)" horizontal={false} />
      <XAxis type="number" stroke="hsl(215 20% 55%)" fontSize={11} tickLine={false} axisLine={false} />
      <YAxis type="category" dataKey="name" stroke="hsl(215 20% 55%)" fontSize={11} width={90} tickLine={false} axisLine={false} />
      <Tooltip content={<ChartTooltip />} cursor={{ fill: "hsl(185 100% 50% / 0.05)" }} />
      <Bar dataKey="value" fill="url(#barGrad)" radius={[0, 6, 6, 0]} />
    </BarChart>
  </ResponsiveContainer>
);

const PIE_COLORS = ["hsl(185 100% 50%)", "hsl(300 100% 45%)", "hsl(150 100% 50%)", "hsl(38 100% 50%)", "hsl(0 100% 60%)", "hsl(210 100% 60%)"];
export const CountryPie = ({ data, height = 240 }: { data: BarItem[]; height?: number }) => (
  <ResponsiveContainer width="100%" height={height}>
    <PieChart>
      <Tooltip content={<ChartTooltip />} />
      <Pie data={data} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={3} stroke="none">
        {data.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
      </Pie>
    </PieChart>
  </ResponsiveContainer>
);

/** Circular gauge for success rate (0-100). Premium feel. */
export const SuccessGauge = ({ value, height = 200, label = "Success Rate" }: { value: number; height?: number; label?: string }) => {
  const v = Math.max(0, Math.min(100, value));
  const data = [{ name: label, value: v, fill: "hsl(150 100% 50%)" }];
  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={height}>
        <RadialBarChart cx="50%" cy="50%" innerRadius="70%" outerRadius="100%" barSize={14} data={data} startAngle={220} endAngle={-40}>
          <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
          <RadialBar background={{ fill: "hsl(240 10% 12%)" }} dataKey="value" cornerRadius={10} />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <span className={cn("text-3xl font-display font-bold", v >= 70 ? "text-neon-green" : v >= 40 ? "text-neon-amber" : "text-destructive")}>
          {Math.round(v)}%
        </span>
        <span className="text-xs text-muted-foreground mt-0.5">{label}</span>
      </div>
    </div>
  );
};

/** Tiny inline sparkline (height ~40) for KPI cards */
export const Sparkline = ({ data, color = "hsl(185 100% 50%)", height = 40 }: { data: number[]; color?: string; height?: number }) => {
  const points = data.map((v, i) => ({ i, v }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={points} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
        <Line type="monotone" dataKey="v" stroke={color} strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
};

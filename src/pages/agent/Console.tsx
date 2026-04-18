import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { GlassCard } from "@/components/GlassCard";
import { Input } from "@/components/ui/input";
import { Search, RefreshCw, Copy, Check, Inbox, Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { toast } from "@/hooks/use-toast";

// Shorten IMS range names like "Peru Bitel TF04" → "TF04"
const shortRange = (operator?: string | null) => {
  if (!operator) return "";
  const parts = operator.trim().split(/\s+/);
  return parts[parts.length - 1] || operator;
};

// Mask OTP digits: "785590" → "XXXXXX"
const maskOtp = (otp?: string | null) => (otp ? "X".repeat(otp.length) : "");

const AgentConsole = () => {
  const { data, refetch, isFetching } = useQuery({
    queryKey: ["my-cdr-console"],
    queryFn: () => api.cdr.mine(),
    refetchInterval: 5000,
  });
  const [search, setSearch] = useState("");
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const items = useMemo(() => {
    const cdr = data?.cdr || [];
    return cdr.filter(c => c.otp_code).filter((c) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return (
        c.phone_number.toLowerCase().includes(q) ||
        (c.operator || "").toLowerCase().includes(q) ||
        (c.otp_code || "").toLowerCase().includes(q)
      );
    });
  }, [data, search]);

  const copyText = (id: number, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
    toast({ title: "Copied!", description: text });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-bold text-foreground">Console</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Your real OTP feed — Server A shows operator, Server B shows range code.
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
          placeholder="Search by number, range/operator, or OTP..."
          className="pl-10 bg-white/[0.04] border-white/[0.1] h-11"
        />
      </div>

      <div className="space-y-3">
        {items.map((c) => {
          const isIms = c.provider === "ims";
          const label = isIms ? shortRange(c.operator) : (c.operator || c.country_code || "—");
          const labelStyle = isIms
            ? "bg-neon-magenta/10 text-neon-magenta"
            : "bg-neon-cyan/10 text-neon-cyan";
          return (
            <GlassCard key={c.id} className="!p-4 hover:neon-border-cyan transition-all">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-mono text-primary">{c.phone_number}</span>
                    <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-semibold", labelStyle)}>
                      {label}
                    </span>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-neon-green/10 text-neon-green">
                      +৳{(+c.price_bdt).toFixed(2)}
                    </span>
                  </div>
                  <p className="mt-2 text-base text-foreground leading-relaxed font-mono tracking-widest">
                    OTP: <span className="text-neon-green font-bold">{c.otp_code}</span>
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => copyText(c.id, c.otp_code || "")}
                    className="p-1.5 rounded-md hover:bg-white/[0.06] text-muted-foreground hover:text-neon-green transition-colors"
                    title="Copy OTP"
                  >
                    {copiedId === c.id ? <Check className="w-4 h-4 text-neon-green" /> : <Copy className="w-4 h-4" />}
                  </button>
                  <div className="text-right ml-2">
                    <p className="text-xs text-muted-foreground">{new Date(c.created_at * 1000).toLocaleTimeString()}</p>
                    <p className="text-[10px] text-muted-foreground/70">{new Date(c.created_at * 1000).toLocaleDateString()}</p>
                  </div>
                </div>
              </div>
            </GlassCard>
          );
        })}
        {items.length === 0 && (
          <div className="text-center py-16 text-muted-foreground">
            <Inbox className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="text-sm">No OTPs yet — they will appear here in real time as numbers receive codes.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default AgentConsole;

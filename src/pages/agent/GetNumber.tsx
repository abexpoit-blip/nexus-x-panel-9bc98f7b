import { useState, useEffect } from "react";
import { GlassCard } from "@/components/GlassCard";
import { Button } from "@/components/ui/button";
import { Hash, Copy, Check, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";

interface AllocatedNumber {
  id: number;
  phone_number: string;
  operator?: string | null;
  otp: string | null;
  status: "active" | "received" | "expired";
}

const AgentGetNumber = () => {
  const { user } = useAuth();
  const [, setProviders] = useState<{ id: string; name: string }[]>([]);
  const [provider, setProvider] = useState<string>("acchub");
  const [countries, setCountries] = useState<any[]>([]);
  const [countryId, setCountryId] = useState<number | "">("");
  const [operators, setOperators] = useState<any[]>([]);
  const [operatorId, setOperatorId] = useState<number | "">("");
  const [numbers, setNumbers] = useState<AllocatedNumber[]>([]);
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [copiedOtpId, setCopiedOtpId] = useState<number | null>(null);

  const maxPerRequest = user?.per_request_limit ?? 15;
  const dailyLimit = user?.daily_limit ?? 100;
  const usedToday = numbers.length;

  // Force AccHub only — provider name hidden from agents
  useEffect(() => {
    setProvider("acchub");
    api.myNumbers().then(({ numbers }) => setNumbers(numbers as any)).catch(() => {});
  }, []);

  // Load countries when provider changes (auto-loaded, hidden from agent)
  useEffect(() => {
    if (!provider) return;
    setCountries([]); setCountryId(""); setOperators([]); setOperatorId("");
    api.countries(provider).then(({ countries }) => setCountries(countries)).catch(() => {});
  }, [provider]);

  // Load operators when country changes
  useEffect(() => {
    if (!provider || !countryId) return;
    api.operators(provider, Number(countryId)).then(({ operators }) => setOperators(operators)).catch(() => {});
  }, [provider, countryId]);

  const handleGetNumber = async () => {
    if (!provider) return;
    if (provider === "acchub" && (!countryId || !operatorId)) {
      toast({ title: "Select country & operator", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      const { allocated, errors } = await api.getNumber({
        provider,
        country_id: countryId ? Number(countryId) : undefined,
        operator_id: operatorId ? Number(operatorId) : undefined,
        count: 1,
      });
      setNumbers((prev) => [...allocated.map((a: any) => ({ ...a, status: "active" })), ...prev]);
      if (allocated.length) toast({ title: "Number allocated!", description: allocated[0].phone_number });
      if (errors.length) toast({ title: "Some failed", description: errors.join(", "), variant: "destructive" });
    } catch (e: any) {
      toast({ title: "Failed", description: e.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  // Poll OTP sync every 5s while there are pending numbers
  useEffect(() => {
    const pending = numbers.filter((n) => !n.otp).length;
    if (pending === 0) return;
    const interval = setInterval(async () => {
      try {
        await api.syncOtp();
        const { numbers: fresh } = await api.myNumbers();
        setNumbers(fresh as any);
      } catch {}
    }, 5000);
    return () => clearInterval(interval);
  }, [numbers]);

  const copyItem = (id: number, text: string, type: "num" | "otp") => {
    navigator.clipboard.writeText(text);
    if (type === "num") { setCopiedId(id); setTimeout(() => setCopiedId(null), 1500); }
    else { setCopiedOtpId(id); setTimeout(() => setCopiedOtpId(null), 1500); }
  };

  const copyAll = () => {
    const all = numbers.map(n => n.otp ? `${n.phone_number}|${n.otp}` : n.phone_number).join("\n");
    navigator.clipboard.writeText(all);
    toast({ title: "Copied!", description: `${numbers.length} entries copied` });
  };

  const downloadTxt = () => {
    const content = numbers.map(n => n.otp ? `${n.phone_number}|${n.otp}` : n.phone_number).join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nexusx-numbers-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Downloaded!", description: `${numbers.length} entries saved as Number|OTP format` });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-bold text-foreground">Get Number</h1>
        <p className="text-sm text-muted-foreground mt-1">Request real numbers from connected providers</p>
      </div>

      <GlassCard glow="cyan">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground">Country</label>
            <select
              value={countryId}
              onChange={(e) => setCountryId(e.target.value ? Number(e.target.value) : "")}
              className="w-full h-11 rounded-lg bg-white/[0.04] border border-white/[0.1] px-3 text-sm text-foreground focus:outline-none focus:border-primary/50"
            >
              <option value="" className="bg-card">Select country</option>
              {countries.map((c) => (
                <option key={c.id} value={c.id} className="bg-card">{c.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground">Operator</label>
            <select
              value={operatorId}
              onChange={(e) => setOperatorId(e.target.value ? Number(e.target.value) : "")}
              disabled={!countryId}
              className="w-full h-11 rounded-lg bg-white/[0.04] border border-white/[0.1] px-3 text-sm text-foreground focus:outline-none focus:border-primary/50 disabled:opacity-50"
            >
              <option value="" className="bg-card">Select operator</option>
              {operators.map((o) => (
                <option key={o.id} value={o.id} className="bg-card">{o.name}</option>
              ))}
            </select>
          </div>
          <Button
            onClick={handleGetNumber}
            disabled={!provider || loading || usedToday >= dailyLimit || !operatorId}
            className="h-11 bg-gradient-to-r from-primary to-neon-magenta text-primary-foreground font-semibold hover:opacity-90 border-0"
          >
            {loading ? (
              <div className="w-5 h-5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
            ) : (
              <>
                <Hash className="w-4 h-4 mr-2" />
                Get Number
              </>
            )}
          </Button>
        </div>
        <div className="flex items-center justify-between mt-4 pt-4 border-t border-white/[0.06]">
          <div className="flex gap-6">
            <span className="text-xs text-muted-foreground">
              Per request: <span className="text-primary font-semibold">{maxPerRequest}</span>
            </span>
            <span className="text-xs text-muted-foreground">
              Daily: <span className="text-primary font-semibold">{usedToday}</span> / {dailyLimit}
            </span>
          </div>
          <div className="w-32 h-1.5 rounded-full bg-white/[0.06]">
            <div
              className="h-full rounded-full bg-gradient-to-r from-primary to-neon-magenta transition-all duration-500"
              style={{ width: `${Math.min((usedToday / dailyLimit) * 100, 100)}%` }}
            />
          </div>
        </div>
      </GlassCard>

      {numbers.length > 0 && (
        <GlassCard>
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-display font-semibold text-foreground">Allocated Numbers & OTPs</h3>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={copyAll} className="glass border-white/[0.1] hover:bg-white/[0.06] text-xs">
                <Copy className="w-3.5 h-3.5 mr-1" /> Copy All
              </Button>
              <Button size="sm" variant="outline" onClick={downloadTxt} className="glass border-white/[0.1] hover:bg-white/[0.06] text-xs">
                <Download className="w-3.5 h-3.5 mr-1" /> Download .txt
              </Button>
            </div>
          </div>

          {/* Header */}
          <div className="grid grid-cols-[auto_1fr_120px_100px_80px] gap-3 px-4 py-2 text-xs font-semibold text-muted-foreground border-b border-white/[0.06] mb-1">
            <span className="w-2" />
            <span>Number</span>
            <span>Operator</span>
            <span>OTP</span>
            <span className="text-right">Actions</span>
          </div>

          <div className="space-y-1 max-h-[500px] overflow-y-auto scrollbar-none">
            {numbers.map((n) => (
              <div
                key={n.id}
                className="grid grid-cols-[auto_1fr_120px_100px_80px] gap-3 items-center px-4 py-3 rounded-lg bg-white/[0.02] border border-white/[0.04] hover:bg-white/[0.04] transition-colors"
              >
                <div className={cn(
                  "w-2 h-2 rounded-full",
                  n.otp ? "bg-neon-green" : n.status === "active" ? "bg-neon-amber animate-pulse" : "bg-neon-red"
                )} />
                <div className="flex items-center gap-2">
                  <span className="text-sm font-mono text-foreground">{n.phone_number}</span>
                  <button
                    onClick={() => copyItem(n.id, n.phone_number, "num")}
                    className="p-1 rounded hover:bg-white/[0.06] text-muted-foreground hover:text-primary transition-colors"
                    title="Copy number"
                  >
                    {copiedId === n.id ? <Check className="w-3.5 h-3.5 text-neon-green" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
                <span className="text-xs text-muted-foreground">{n.operator || "—"}</span>
                <div className="flex items-center gap-1">
                  {n.otp ? (
                    <>
                      <span className="text-sm font-mono text-neon-green font-semibold">{n.otp}</span>
                      <button
                        onClick={() => copyItem(n.id, n.otp!, "otp")}
                        className="p-1 rounded hover:bg-white/[0.06] text-muted-foreground hover:text-neon-green transition-colors"
                        title="Copy OTP"
                      >
                        {copiedOtpId === n.id ? <Check className="w-3.5 h-3.5 text-neon-green" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground italic">Waiting...</span>
                  )}
                </div>
                <div className="flex justify-end">
                  <span className={cn(
                    "px-2 py-0.5 rounded-full text-[10px] font-semibold",
                    n.otp ? "bg-neon-green/10 text-neon-green" : "bg-neon-amber/10 text-neon-amber"
                  )}>
                    {n.otp ? "Received" : "Pending"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </GlassCard>
      )}
    </div>
  );
};

export default AgentGetNumber;

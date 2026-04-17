import { useState, useEffect, useMemo, useRef } from "react";
import { GlassCard } from "@/components/GlassCard";
import { Button } from "@/components/ui/button";
import { Hash, Copy, Check, Download, Search, ChevronDown, Wallet } from "lucide-react";
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

interface Country {
  id: number;
  name: string;
  code?: string;
  flag?: string;
  price_bdt?: number;
}

interface Operator {
  id: number;
  name: string;
  price_bdt?: number;
}

const AgentGetNumber = () => {
  const { user } = useAuth();
  const provider = "acchub"; // hidden from agents
  const [countries, setCountries] = useState<Country[]>([]);
  const [countryId, setCountryId] = useState<number | "">("");
  const [operators, setOperators] = useState<Operator[]>([]);
  const [operatorId, setOperatorId] = useState<number | "">("");
  const [numbers, setNumbers] = useState<AllocatedNumber[]>([]);
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [copiedOtpId, setCopiedOtpId] = useState<number | null>(null);

  // Country search dropdown
  const [countryOpen, setCountryOpen] = useState(false);
  const [countrySearch, setCountrySearch] = useState("");
  const countryRef = useRef<HTMLDivElement>(null);

  const maxPerRequest = user?.per_request_limit ?? 15;
  const dailyLimit = user?.daily_limit ?? 100;
  const usedToday = numbers.length;

  const selectedCountry = countries.find((c) => c.id === countryId);
  const selectedOperator = operators.find((o) => o.id === operatorId);
  const cost = selectedOperator?.price_bdt ?? selectedCountry?.price_bdt ?? null;

  useEffect(() => {
    api.myNumbers().then(({ numbers }) => setNumbers(numbers as AllocatedNumber[])).catch(() => {});
    api.countries(provider).then(({ countries }) => setCountries(countries)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!countryId) { setOperators([]); setOperatorId(""); return; }
    setOperatorId("");
    api.operators(provider, Number(countryId)).then(({ operators }) => setOperators(operators)).catch(() => {});
  }, [countryId]);

  // Close country dropdown on outside click
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (countryRef.current && !countryRef.current.contains(e.target as Node)) setCountryOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const filteredCountries = useMemo(() => {
    const q = countrySearch.trim().toLowerCase();
    if (!q) return countries;
    return countries.filter((c) =>
      c.name.toLowerCase().includes(q) || (c.code || "").includes(q)
    );
  }, [countries, countrySearch]);

  const handleGetNumber = async () => {
    if (!countryId || !operatorId) {
      toast({ title: "Select country & operator", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      const { allocated, errors } = await api.getNumber({
        provider,
        country_id: Number(countryId),
        operator_id: Number(operatorId),
        count: 1,
      });
      setNumbers((prev) => [...allocated.map((a: AllocatedNumber) => ({ ...a, status: "active" as const })), ...prev]);
      if (allocated.length) toast({ title: "Number allocated!", description: allocated[0].phone_number });
      if (errors.length) toast({ title: "Some failed", description: errors.join(", "), variant: "destructive" });
    } catch (e: unknown) {
      toast({ title: "Failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
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
        setNumbers(fresh as AllocatedNumber[]);
      } catch { /* ignore */ }
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
        <p className="text-sm text-muted-foreground mt-1">Search a country, pick an operator, and request a fresh number</p>
      </div>

      <GlassCard glow="cyan">
        <div className="grid grid-cols-1 sm:grid-cols-[1.4fr_1fr_auto] gap-4 items-end">
          {/* Country searchable combobox */}
          <div className="space-y-2 relative" ref={countryRef}>
            <label className="text-sm font-medium text-muted-foreground">Country</label>
            <button
              type="button"
              onClick={() => setCountryOpen((v) => !v)}
              className="w-full h-11 rounded-lg bg-white/[0.04] border border-white/[0.1] px-3 text-sm text-foreground focus:outline-none focus:border-primary/50 flex items-center justify-between gap-2"
            >
              <span className={cn("truncate", !selectedCountry && "text-muted-foreground")}>
                {selectedCountry ? selectedCountry.name : "Select country..."}
              </span>
              <div className="flex items-center gap-2 shrink-0">
                {selectedCountry?.price_bdt != null && (
                  <span className="text-xs text-neon-green font-semibold">৳{selectedCountry.price_bdt}</span>
                )}
                <ChevronDown className={cn("w-4 h-4 text-muted-foreground transition-transform", countryOpen && "rotate-180")} />
              </div>
            </button>

            {countryOpen && (
              <div className="absolute z-50 mt-1 w-full rounded-lg bg-card/95 backdrop-blur-xl border border-white/[0.1] shadow-2xl overflow-hidden">
                <div className="p-2 border-b border-white/[0.06] sticky top-0 bg-card/95">
                  <div className="relative">
                    <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <input
                      autoFocus
                      value={countrySearch}
                      onChange={(e) => setCountrySearch(e.target.value)}
                      placeholder="Search country or code (+91, +234...)"
                      className="w-full h-9 pl-9 pr-3 rounded-md bg-white/[0.04] border border-white/[0.08] text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
                    />
                  </div>
                </div>
                <div className="max-h-72 overflow-y-auto scrollbar-none">
                  {filteredCountries.length === 0 ? (
                    <div className="px-3 py-6 text-center text-xs text-muted-foreground">No countries match "{countrySearch}"</div>
                  ) : (
                    filteredCountries.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => { setCountryId(c.id); setCountryOpen(false); setCountrySearch(""); }}
                        className={cn(
                          "w-full px-3 py-2.5 text-left text-sm flex items-center justify-between gap-2 hover:bg-white/[0.06] transition-colors",
                          countryId === c.id && "bg-primary/10 text-primary"
                        )}
                      >
                        <span className="truncate">{c.name}</span>
                        {c.price_bdt != null && (
                          <span className="text-xs text-neon-green font-semibold shrink-0">৳{c.price_bdt}</span>
                        )}
                      </button>
                    ))
                  )}
                </div>
                <div className="px-3 py-2 text-[10px] text-muted-foreground border-t border-white/[0.06] bg-white/[0.02]">
                  {filteredCountries.length} of {countries.length} countries · prices in BDT
                </div>
              </div>
            )}
          </div>

          {/* Operator */}
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
                <option key={o.id} value={o.id} className="bg-card">
                  {o.name}{o.price_bdt != null ? ` — ৳${o.price_bdt}` : ""}
                </option>
              ))}
            </select>
          </div>

          <Button
            onClick={handleGetNumber}
            disabled={loading || usedToday >= dailyLimit || !operatorId}
            className="h-11 bg-gradient-to-r from-primary to-neon-magenta text-primary-foreground font-semibold hover:opacity-90 border-0 min-w-[160px]"
          >
            {loading ? (
              <div className="w-5 h-5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
            ) : (
              <>
                <Hash className="w-4 h-4 mr-2" />
                Get Number{cost != null ? ` · ৳${cost}` : ""}
              </>
            )}
          </Button>
        </div>

        <div className="flex items-center justify-between mt-4 pt-4 border-t border-white/[0.06] flex-wrap gap-3">
          <div className="flex gap-6 flex-wrap">
            <span className="text-xs text-muted-foreground">
              Per request: <span className="text-primary font-semibold">{maxPerRequest}</span>
            </span>
            <span className="text-xs text-muted-foreground">
              Daily: <span className="text-primary font-semibold">{usedToday}</span> / {dailyLimit}
            </span>
            {cost != null && (
              <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Wallet className="w-3.5 h-3.5 text-neon-green" />
                Cost per number: <span className="text-neon-green font-semibold">৳{cost} BDT</span>
              </span>
            )}
          </div>
          <div className="w-32 h-1.5 rounded-full bg-white/[0.06]">
            <div
              className="h-full rounded-full bg-gradient-to-r from-primary to-neon-magenta transition-all duration-500"
              style={{ width: `${Math.min((usedToday / dailyLimit) * 100, 100)}%` }}
            />
          </div>
        </div>
      </GlassCard>

      {/* Pricing rate card grid */}
      {countries.length > 0 && (
        <GlassCard>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-display font-semibold text-foreground">Country Pricing</h3>
              <p className="text-xs text-muted-foreground mt-0.5">Tap any country to select it instantly</p>
            </div>
            <span className="text-xs text-muted-foreground">{countries.length} countries available</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
            {countries.map((c) => (
              <button
                key={c.id}
                onClick={() => setCountryId(c.id)}
                className={cn(
                  "group flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg border text-left transition-all",
                  countryId === c.id
                    ? "bg-primary/10 border-primary/40 shadow-[0_0_0_1px_hsl(var(--primary)/0.3)]"
                    : "bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.06] hover:border-white/[0.12]"
                )}
              >
                <span className="text-xs text-foreground truncate">{c.name}</span>
                <span className={cn(
                  "text-xs font-semibold shrink-0",
                  countryId === c.id ? "text-primary" : "text-neon-green"
                )}>
                  ৳{c.price_bdt ?? "—"}
                </span>
              </button>
            ))}
          </div>
        </GlassCard>
      )}

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

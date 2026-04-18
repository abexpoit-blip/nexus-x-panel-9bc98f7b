import { useState, useEffect, useMemo, useRef } from "react";
import { GlassCard } from "@/components/GlassCard";
import { Button } from "@/components/ui/button";
import { Hash, Copy, Check, Download, Search, ChevronDown, Wallet, AlertTriangle, Layers, Server, ChevronLeft, ChevronRight } from "lucide-react";
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

interface Range {
  name: string;
  count: number;
}

// Agents see "Server A" / "Server B" — real provider names (acchub/ims) are hidden.
const SERVERS = [
  { id: "acchub", label: "Server A" },
  { id: "ims", label: "Server B" },
] as const;
type ServerId = typeof SERVERS[number]["id"];

const AgentGetNumber = () => {
  const { user, maintenanceMode, maintenanceMessage } = useAuth();
  const [provider, setProvider] = useState<ServerId>("acchub");
  const [countries, setCountries] = useState<Country[]>([]);
  const [countryId, setCountryId] = useState<number | "">("");
  const [operators, setOperators] = useState<Operator[]>([]);
  const [operatorId, setOperatorId] = useState<number | "">("");
  const [ranges, setRanges] = useState<Range[]>([]);
  const [rangeName, setRangeName] = useState<string>("");
  const [rangeSearch, setRangeSearch] = useState("");
  const [rangeOpen, setRangeOpen] = useState(false);
  const rangeRef = useRef<HTMLDivElement>(null);
  const [numbers, setNumbers] = useState<AllocatedNumber[]>([]);
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [copiedOtpId, setCopiedOtpId] = useState<number | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 25;

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
  const totalCost = cost != null ? cost * quantity : null;

  // Quantity options capped to per-request limit
  const quantityOptions = [1, 5, 10, 15].filter((q) => q <= maxPerRequest);

  useEffect(() => {
    api.myNumbers().then(({ numbers }) => setNumbers(numbers as AllocatedNumber[])).catch(() => {});
  }, []);

  // Reload countries OR ranges whenever the agent switches Server A / B
  useEffect(() => {
    setCountryId("");
    setOperatorId("");
    setOperators([]);
    setRangeName("");
    if (provider === "ims") {
      api.imsRanges().then(({ ranges }) => setRanges(ranges)).catch(() => setRanges([]));
      setCountries([]);
    } else {
      setRanges([]);
      api.countries(provider).then(({ countries }) => setCountries(countries)).catch(() => setCountries([]));
    }
  }, [provider]);

  // Refresh range counts every 10s while Server B is selected
  useEffect(() => {
    if (provider !== "ims") return;
    const i = setInterval(() => {
      api.imsRanges().then(({ ranges }) => setRanges(ranges)).catch(() => {});
    }, 10000);
    return () => clearInterval(i);
  }, [provider]);

  useEffect(() => {
    if (provider === "ims" || !countryId) { setOperators([]); setOperatorId(""); return; }
    setOperatorId("");
    api.operators(provider, Number(countryId)).then(({ operators }) => setOperators(operators)).catch(() => {});
  }, [countryId, provider]);

  // Close country/range dropdowns on outside click
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (countryRef.current && !countryRef.current.contains(e.target as Node)) setCountryOpen(false);
      if (rangeRef.current && !rangeRef.current.contains(e.target as Node)) setRangeOpen(false);
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

  const filteredRanges = useMemo(() => {
    const q = rangeSearch.trim().toLowerCase();
    if (!q) return ranges;
    return ranges.filter((r) => r.name.toLowerCase().includes(q));
  }, [ranges, rangeSearch]);

  const selectedRange = ranges.find((r) => r.name === rangeName);
  const totalPoolSize = ranges.reduce((sum, r) => sum + r.count, 0);

  const handleGetNumber = async () => {
    if (maintenanceMode) {
      toast({ title: "Maintenance mode", description: maintenanceMessage, variant: "destructive" });
      return;
    }
    if (provider === "ims") {
      if (!rangeName) { toast({ title: "Select a range", variant: "destructive" }); return; }
    } else if (!countryId || !operatorId) {
      toast({ title: "Select country & operator", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      const { allocated, errors } = await api.getNumber({
        provider,
        ...(provider === "ims"
          ? { range: rangeName }
          : { country_id: Number(countryId), operator_id: Number(operatorId) }),
        count: quantity,
      });
      setNumbers((prev) => [...allocated.map((a: AllocatedNumber) => ({ ...a, status: "active" as const })), ...prev]);
      if (allocated.length) toast({ title: `${allocated.length} number${allocated.length > 1 ? "s" : ""} allocated!`, description: allocated[0].phone_number });
      if (errors.length) toast({ title: "Some failed", description: errors.join(", "), variant: "destructive" });
      if (provider === "ims") api.imsRanges().then(({ ranges }) => setRanges(ranges)).catch(() => {});
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

      {maintenanceMode && (
        <GlassCard className="border-neon-amber/40 bg-neon-amber/[0.06]">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-6 h-6 text-neon-amber shrink-0 mt-0.5" />
            <div>
              <h3 className="font-display font-semibold text-neon-amber">Maintenance Mode Active</h3>
              <p className="text-sm text-muted-foreground mt-1">{maintenanceMessage}</p>
              <p className="text-xs text-muted-foreground mt-2">Number allocation is temporarily disabled. Please check back soon.</p>
            </div>
          </div>
        </GlassCard>
      )}

      <GlassCard glow="cyan">
        {/* Server selector — Server A = AccHub, Server B = IMS (real names hidden) */}
        <div className="flex items-center gap-2 mb-4 pb-4 border-b border-white/[0.06]">
          <Server className="w-4 h-4 text-neon-cyan" />
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mr-2">Source</span>
          <div className="flex gap-2">
            {SERVERS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setProvider(s.id)}
                className={cn(
                  "px-4 h-9 rounded-lg text-xs font-bold transition-all border",
                  provider === s.id
                    ? "bg-gradient-to-r from-primary to-neon-magenta text-primary-foreground border-transparent shadow-[0_0_18px_-4px_hsl(var(--primary)/0.6)]"
                    : "bg-white/[0.03] text-foreground border-white/[0.08] hover:bg-white/[0.08] hover:border-white/[0.16]",
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {provider === "ims" ? (
          /* ============ Server B (IMS): single Range dropdown ============ */
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-4 items-end">
            <div className="space-y-2 relative" ref={rangeRef}>
              <label className="text-sm font-medium text-muted-foreground flex items-center justify-between">
                <span>Range</span>
                <span className="text-[10px] text-muted-foreground/70 font-normal">
                  {ranges.length} ranges · <span className="text-neon-green font-semibold">{totalPoolSize}</span> numbers in pool
                </span>
              </label>
              <button
                type="button"
                onClick={() => setRangeOpen((v) => !v)}
                className="w-full h-11 rounded-lg bg-white/[0.04] border border-white/[0.1] px-3 text-sm text-foreground focus:outline-none focus:border-primary/50 flex items-center justify-between gap-2"
              >
                <span className={cn("truncate", !selectedRange && "text-muted-foreground")}>
                  {selectedRange ? (
                    <>
                      {selectedRange.name}
                      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-neon-green/15 text-neon-green font-semibold">
                        {selectedRange.count} avail
                      </span>
                    </>
                  ) : ranges.length === 0 ? "No ranges available — wait for refill" : "Select a range..."}
                </span>
                <ChevronDown className={cn("w-4 h-4 text-muted-foreground transition-transform shrink-0", rangeOpen && "rotate-180")} />
              </button>

              {rangeOpen && (
                <div className="absolute z-[100] mt-1 w-full rounded-lg bg-[hsl(var(--card))] border border-white/[0.12] shadow-2xl overflow-hidden">
                  <div className="p-2 border-b border-white/[0.06] sticky top-0 bg-[hsl(var(--card))]">
                    <div className="relative">
                      <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <input
                        autoFocus
                        value={rangeSearch}
                        onChange={(e) => setRangeSearch(e.target.value)}
                        placeholder="Search range (Peru, Bitel, TF04...)"
                        className="w-full h-9 pl-9 pr-3 rounded-md bg-white/[0.04] border border-white/[0.08] text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
                      />
                    </div>
                  </div>
                  <div className="max-h-72 overflow-y-auto scrollbar-none bg-[hsl(var(--card))]">
                    {filteredRanges.length === 0 ? (
                      <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                        {ranges.length === 0 ? "Pool is empty — admin needs to refill" : `No ranges match "${rangeSearch}"`}
                      </div>
                    ) : (
                      filteredRanges.map((r) => (
                        <button
                          key={r.name}
                          onClick={() => { setRangeName(r.name); setRangeOpen(false); setRangeSearch(""); }}
                          className={cn(
                            "w-full px-3 py-2.5 text-left text-sm flex items-center justify-between gap-2 hover:bg-white/[0.06] transition-colors",
                            rangeName === r.name && "bg-primary/10 text-primary"
                          )}
                        >
                          <span className="truncate">{r.name}</span>
                          <span className={cn(
                            "text-[10px] px-1.5 py-0.5 rounded font-mono font-semibold shrink-0",
                            r.count > 50 ? "bg-neon-green/15 text-neon-green" :
                            r.count > 10 ? "bg-neon-amber/15 text-neon-amber" :
                            "bg-destructive/15 text-destructive"
                          )}>
                            {r.count}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>

            <Button
              onClick={handleGetNumber}
              disabled={loading || maintenanceMode || usedToday >= dailyLimit || !rangeName}
              className="h-11 bg-gradient-to-r from-primary to-neon-magenta text-primary-foreground font-semibold hover:opacity-90 border-0 min-w-[180px]"
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
              ) : (
                <>
                  <Hash className="w-4 h-4 mr-2" />
                  Get {quantity > 1 ? `${quantity} Numbers` : "Number"}
                </>
              )}
            </Button>
          </div>
        ) : (
          /* ============ Server A (AccHub): Country + Operator ============ */
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
                <ChevronDown className={cn("w-4 h-4 text-muted-foreground transition-transform shrink-0", countryOpen && "rotate-180")} />
              </button>

              {countryOpen && (
                <div className="absolute z-[100] mt-1 w-full rounded-lg bg-[hsl(var(--card))] border border-white/[0.12] shadow-2xl overflow-hidden">
                  <div className="p-2 border-b border-white/[0.06] sticky top-0 bg-[hsl(var(--card))]">
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
                  <div className="max-h-72 overflow-y-auto scrollbar-none bg-[hsl(var(--card))]">
                    {filteredCountries.length === 0 ? (
                      <div className="px-3 py-6 text-center text-xs text-muted-foreground">No countries match "{countrySearch}"</div>
                    ) : (
                      filteredCountries.map((c) => (
                        <button
                          key={c.id}
                          onClick={() => { setCountryId(c.id); setCountryOpen(false); setCountrySearch(""); }}
                          className={cn(
                            "w-full px-3 py-2.5 text-left text-sm flex items-center gap-2 hover:bg-white/[0.06] transition-colors",
                            countryId === c.id && "bg-primary/10 text-primary"
                          )}
                        >
                          <span className="truncate">{c.name}</span>
                        </button>
                      ))
                    )}
                  </div>
                  <div className="px-3 py-2 text-[10px] text-muted-foreground border-t border-white/[0.06] bg-[hsl(var(--card))]">
                    {filteredCountries.length} of {countries.length} countries
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
                  <option key={o.id} value={o.id} className="bg-card">{o.name}</option>
                ))}
              </select>
            </div>

            <Button
              onClick={handleGetNumber}
              disabled={loading || maintenanceMode || usedToday >= dailyLimit || !operatorId}
              className="h-11 bg-gradient-to-r from-primary to-neon-magenta text-primary-foreground font-semibold hover:opacity-90 border-0 min-w-[180px]"
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
              ) : (
                <>
                  <Hash className="w-4 h-4 mr-2" />
                  Get {quantity > 1 ? `${quantity} Numbers` : "Number"}
                </>
              )}
            </Button>
          </div>
        )}

        {/* Bulk quantity selector */}
        {quantityOptions.length > 1 && (
          <div className="flex items-center justify-between gap-3 mt-4 pt-4 border-t border-white/[0.06] flex-wrap">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-neon-cyan" />
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Bulk request</span>
            </div>
            <div className="flex gap-2">
              {quantityOptions.map((q) => (
                <button
                  key={q}
                  onClick={() => setQuantity(q)}
                  disabled={maintenanceMode}
                  className={cn(
                    "min-w-[56px] h-9 px-4 rounded-lg text-xs font-bold transition-all border",
                    quantity === q
                      ? "bg-gradient-to-r from-primary to-neon-magenta text-primary-foreground border-transparent shadow-[0_0_18px_-4px_hsl(var(--primary)/0.6)]"
                      : "bg-white/[0.03] text-foreground border-white/[0.08] hover:bg-white/[0.08] hover:border-white/[0.16]",
                    maintenanceMode && "opacity-40 cursor-not-allowed",
                  )}
                >
                  {q}×
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between mt-4 pt-4 border-t border-white/[0.06] flex-wrap gap-3">
          <div className="flex gap-6 flex-wrap">
            <span className="text-xs text-muted-foreground">
              Per request: <span className="text-primary font-semibold">{maxPerRequest}</span>
            </span>
            <span className="text-xs text-muted-foreground">
              Daily: <span className="text-primary font-semibold">{usedToday}</span> / {dailyLimit}
            </span>
            <span className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Wallet className="w-3.5 h-3.5 text-neon-green" />
              Earn commission on every successful OTP
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

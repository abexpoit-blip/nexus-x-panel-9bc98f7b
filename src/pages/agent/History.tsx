import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { api } from "@/lib/api";
import { GlassCard } from "@/components/GlassCard";
import { DataTable } from "@/components/DataTable";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  History as HistoryIcon, Search, ChevronLeft, ChevronRight,
  Copy, Check, CalendarIcon, Download, X
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// Permanent record of EVERY successful OTP this agent has ever delivered.
// Sourced from the `cdr` table on the backend, so entries survive even after
// the originating allocation row gets purged by admin housekeeping.
const AgentHistory = () => {
  const [q, setQ] = useState("");
  const [qInput, setQInput] = useState("");
  const [page, setPage] = useState(1);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [fromDate, setFromDate] = useState<Date | undefined>();
  const [toDate, setToDate] = useState<Date | undefined>();
  const [exporting, setExporting] = useState(false);
  const PAGE_SIZE = 50;

  // Date filters convert to YYYY-MM-DD strings — backend treats `to` as
  // end-of-day inclusive so the user's intuition matches.
  const fromStr = fromDate ? format(fromDate, "yyyy-MM-dd") : undefined;
  const toStr = toDate ? format(toDate, "yyyy-MM-dd") : undefined;

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["otp-history", page, q, fromStr, toStr],
    queryFn: () => api.numberHistory({
      page, page_size: PAGE_SIZE,
      q: q || undefined, from: fromStr, to: toStr,
    }),
    placeholderData: (prev) => prev,
  });

  const copyOtp = async (id: number, otp: string) => {
    try {
      await navigator.clipboard.writeText(otp);
      setCopiedId(id);
      toast.success("OTP copied");
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      toast.error("Copy failed");
    }
  };

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    setQ(qInput.trim());
  };

  const clearFilters = () => {
    setQ(""); setQInput("");
    setFromDate(undefined); setToDate(undefined);
    setPage(1);
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const { rows } = await api.numberHistoryCsv({ q: q || undefined, from: fromStr, to: toStr });
      toast.success(`Exported ${rows} OTP records`);
    } catch (e) {
      toast.error("Export failed: " + (e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const totalPages = data?.total_pages ?? 1;
  const summary = data?.summary;
  const hasFilters = !!(q || fromStr || toStr);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-display font-bold text-foreground flex items-center gap-2">
            <HistoryIcon className="w-7 h-7 text-primary" /> OTP History
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Permanent log of every successful OTP you've delivered.
          </p>
        </div>
        {summary && (
          <div className="flex gap-3 text-xs">
            <div className="px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08]">
              <span className="text-muted-foreground">Total OTPs: </span>
              <span className="font-mono font-semibold text-foreground">{summary.count}</span>
            </div>
            <div className="px-3 py-2 rounded-lg bg-neon-green/10 border border-neon-green/20">
              <span className="text-muted-foreground">Earned: </span>
              <span className="font-mono font-semibold text-neon-green">৳{summary.earnings_bdt.toFixed(2)}</span>
            </div>
          </div>
        )}
      </div>

      <GlassCard className="p-4 space-y-3">
        <form onSubmit={submitSearch} className="flex gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder="Search phone, OTP, or operator…"
              className="pl-9 bg-white/[0.04] border-white/[0.08]"
            />
          </div>
          <Button type="submit" variant="outline">Search</Button>
        </form>

        {/* Date range + export */}
        <div className="flex gap-2 flex-wrap items-center">
          <span className="text-xs text-muted-foreground uppercase tracking-wider">Date range:</span>

          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "justify-start text-left font-normal min-w-[150px]",
                  !fromDate && "text-muted-foreground"
                )}
              >
                <CalendarIcon className="w-3.5 h-3.5 mr-2" />
                {fromDate ? format(fromDate, "PPP") : "From date"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={fromDate}
                onSelect={(d) => { setFromDate(d); setPage(1); }}
                disabled={(d) => d > new Date() || (toDate ? d > toDate : false)}
                initialFocus
                className={cn("p-3 pointer-events-auto")}
              />
            </PopoverContent>
          </Popover>

          <span className="text-muted-foreground text-xs">→</span>

          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "justify-start text-left font-normal min-w-[150px]",
                  !toDate && "text-muted-foreground"
                )}
              >
                <CalendarIcon className="w-3.5 h-3.5 mr-2" />
                {toDate ? format(toDate, "PPP") : "To date"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={toDate}
                onSelect={(d) => { setToDate(d); setPage(1); }}
                disabled={(d) => d > new Date() || (fromDate ? d < fromDate : false)}
                initialFocus
                className={cn("p-3 pointer-events-auto")}
              />
            </PopoverContent>
          </Popover>

          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters} className="text-muted-foreground">
              <X className="w-3.5 h-3.5 mr-1" /> Clear
            </Button>
          )}

          <div className="flex-1" />

          <Button
            variant="outline"
            size="sm"
            onClick={exportCsv}
            disabled={exporting || !summary?.count}
            className="bg-neon-green/10 border-neon-green/30 text-neon-green hover:bg-neon-green/20 hover:text-neon-green"
          >
            <Download className={cn("w-3.5 h-3.5 mr-2", exporting && "animate-pulse")} />
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
        </div>
      </GlassCard>

      <DataTable
        columns={[
          {
            key: "phone_number",
            header: "Number",
            render: (r) => <span className="font-mono text-foreground">{r.phone_number}</span>,
          },
          {
            key: "country_code",
            header: "Country",
            render: (r) => <span className="text-muted-foreground text-xs">{r.country_code || "—"}</span>,
          },
          {
            key: "operator",
            header: "Operator",
            render: (r) => <span className="text-muted-foreground text-xs">{r.operator || "—"}</span>,
          },
          {
            key: "otp_code",
            header: "OTP",
            render: (r) => (
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-neon-green font-bold">{r.otp_code}</span>
                <button
                  onClick={() => copyOtp(r.id, r.otp_code)}
                  className="p-1 rounded hover:bg-white/[0.06] text-muted-foreground hover:text-neon-green transition-colors"
                  title="Copy OTP"
                >
                  {copiedId === r.id ? <Check className="w-3 h-3 text-neon-green" /> : <Copy className="w-3 h-3" />}
                </button>
              </div>
            ),
          },
          {
            key: "price_bdt",
            header: "Earned",
            render: (r) => (
              <span className="font-mono text-neon-green/80 text-xs">
                {r.price_bdt > 0 ? `৳${r.price_bdt.toFixed(2)}` : "—"}
              </span>
            ),
          },
          {
            key: "created_at",
            header: "Time",
            render: (r) => (
              <span className="text-xs text-muted-foreground tabular-nums">
                {new Date(r.created_at * 1000).toLocaleString()}
              </span>
            ),
          },
        ]}
        data={data?.rows ?? []}
      />

      {/* Pagination */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          {isLoading ? "Loading…" : data
            ? data.total === 0
              ? "No records match your filters"
              : `Showing ${(page - 1) * PAGE_SIZE + 1}-${Math.min(page * PAGE_SIZE, data.total)} of ${data.total}`
            : "—"}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || isFetching}
          >
            <ChevronLeft className="w-3 h-3 mr-1" /> Prev
          </Button>
          <span className={cn("px-3 py-1 rounded-md font-mono text-foreground", isFetching && "opacity-50")}>
            {page} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages || isFetching}
          >
            Next <ChevronRight className="w-3 h-3 ml-1" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => refetch()}>Refresh</Button>
        </div>
      </div>
    </div>
  );
};

export default AgentHistory;

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { GlassCard } from "@/components/GlassCard";
import { DataTable } from "@/components/DataTable";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Hash, Search, RefreshCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const statusOptions = ["all", "active", "received", "released", "expired"];

const AgentMyNumbers = () => {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["my-numbers"],
    queryFn: () => api.myNumbers(),
    refetchInterval: 10000,
  });

  const release = useMutation({
    mutationFn: (id: number) => api.releaseNumber(id),
    onSuccess: () => {
      toast.success("Number released");
      qc.invalidateQueries({ queryKey: ["my-numbers"] });
    },
    onError: (e: any) => toast.error(e.message || "Failed to release"),
  });

  const sync = useMutation({
    mutationFn: () => api.syncOtp(),
    onSuccess: (r: any) => toast.success(`Synced — ${r.updated || 0} updated`),
  });

  const rows = useMemo(() => {
    const all = data?.numbers || [];
    return all.filter((n) => {
      if (status !== "all" && n.status !== status) return false;
      if (q && !n.phone_number.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
  }, [data, q, status]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-display font-bold text-foreground flex items-center gap-2">
            <Hash className="w-7 h-7 text-primary" /> My Numbers
          </h1>
          <p className="text-sm text-muted-foreground mt-1">All allocations issued to you</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => sync.mutate()} disabled={sync.isPending}>
            <RefreshCw className={cn("w-4 h-4 mr-2", sync.isPending && "animate-spin")} /> Sync OTP
          </Button>
          <Button variant="outline" onClick={() => refetch()}>
            <RefreshCw className="w-4 h-4 mr-2" /> Refresh
          </Button>
        </div>
      </div>

      <GlassCard className="p-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search phone number…"
              className="pl-9 bg-white/[0.04] border-white/[0.08]"
            />
          </div>
          <div className="flex gap-2 flex-wrap">
            {statusOptions.map((s) => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider border transition-colors",
                  status === s
                    ? "bg-primary/20 border-primary/40 text-primary"
                    : "bg-white/[0.02] border-white/[0.08] text-muted-foreground hover:text-foreground"
                )}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </GlassCard>

      <DataTable
        columns={[
          { key: "phone_number", header: "Number", render: (r) => <span className="font-mono text-foreground">{r.phone_number}</span> },
          { key: "country_code", header: "Country", render: (r) => r.country_code || "—" },
          { key: "operator", header: "Operator", render: (r) => r.operator || "—" },
          {
            key: "otp",
            header: "OTP",
            render: (r) =>
              r.otp ? (
                <span className="font-mono text-neon-green font-bold">{r.otp}</span>
              ) : (
                <span className="text-muted-foreground text-xs">waiting…</span>
              ),
          },
          {
            key: "status",
            header: "Status",
            render: (r) => (
              <span
                className={cn(
                  "px-2 py-0.5 rounded text-xs font-semibold uppercase",
                  r.status === "received" && "bg-neon-green/15 text-neon-green",
                  r.status === "active" && "bg-neon-amber/15 text-neon-amber",
                  r.status === "released" && "bg-muted text-muted-foreground",
                  r.status === "expired" && "bg-destructive/15 text-destructive"
                )}
              >
                {r.status}
              </span>
            ),
          },
          {
            key: "allocated_at",
            header: "Time",
            render: (r) => new Date(r.allocated_at * 1000).toLocaleString(),
          },
          {
            key: "actions",
            header: "",
            render: (r) =>
              r.status === "active" ? (
                <button
                  onClick={() => release.mutate(r.id)}
                  className="text-xs text-destructive hover:underline flex items-center gap-1"
                >
                  <X className="w-3 h-3" /> Release
                </button>
              ) : null,
          },
        ]}
        data={rows}
      />
      {isLoading && <p className="text-center text-muted-foreground text-sm">Loading…</p>}
    </div>
  );
};

export default AgentMyNumbers;

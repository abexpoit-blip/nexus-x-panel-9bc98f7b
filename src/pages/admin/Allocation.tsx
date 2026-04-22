import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Agent } from "@/lib/api";
import { DataTable } from "@/components/DataTable";
import { GlassCard } from "@/components/GlassCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Sliders, Pencil, ChevronDown, Search, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { GradientMesh, PageHeader } from "@/components/premium";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

const AdminAllocation = () => {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Agent | null>(null);
  const [daily, setDaily] = useState(0);
  const [perReq, setPerReq] = useState(0);
  const [tab, setTab] = useState<"limits" | "live" | "inspector">("limits");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  const { data } = useQuery({ queryKey: ["agents"], queryFn: () => api.admin.agents() });
  const { data: alloc } = useQuery({ queryKey: ["all-allocations"], queryFn: () => api.admin.allocations(), refetchInterval: 15000 });
  const { data: pool } = useQuery({
    queryKey: ["pool-inspector"],
    queryFn: () => api.admin.poolInspector(),
    refetchInterval: 20000,
    enabled: tab === "inspector",
  });

  const filteredCountries = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = pool?.countries || [];
    if (!q) return list;
    return list.filter(
      (c) =>
        c.country_name.toLowerCase().includes(q) ||
        c.country_code.toLowerCase().includes(q) ||
        c.ranges.some((r) => r.range.toLowerCase().includes(q))
    );
  }, [pool, search]);

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const save = useMutation({
    mutationFn: () => api.admin.updateAgent(editing!.id, { daily_limit: daily, per_request_limit: perReq }),
    onSuccess: () => {
      toast.success("Limits updated");
      qc.invalidateQueries({ queryKey: ["agents"] });
      setEditing(null);
    },
    onError: (e: any) => toast.error(e.message),
  });

  const openEdit = (a: Agent) => {
    setEditing(a);
    setDaily(a.daily_limit);
    setPerReq(a.per_request_limit);
  };

  return (
    <div className="relative space-y-6">
      <GradientMesh variant="default" />
      <PageHeader
        eyebrow="Quotas"
        title="Allocation & Limits"
        description="Per-agent daily and per-request quotas + live allocations"
        icon={<Sliders className="w-5 h-5 text-neon-amber" />}
      />

      <GlassCard className="p-0">
        <div className="p-4 border-b border-white/[0.04]">
          <h3 className="font-display font-semibold">Agent Limits</h3>
        </div>
        <DataTable
          className="border-0 rounded-none"
          columns={[
            { key: "username", header: "Agent", render: (r) => <span className="font-semibold">{r.username}</span> },
            { key: "daily_limit", header: "Daily limit", render: (r) => <span className="font-mono">{r.daily_limit}</span> },
            { key: "per_request_limit", header: "Per request", render: (r) => <span className="font-mono">{r.per_request_limit}</span> },
            { key: "otp_count", header: "Total OTPs", render: (r) => r.otp_count.toLocaleString() },
            {
              key: "actions",
              header: "",
              render: (r) => (
                <button onClick={() => openEdit(r)} className="text-primary hover:underline text-xs flex items-center gap-1">
                  <Pencil className="w-3 h-3" /> Edit limits
                </button>
              ),
            },
          ]}
          data={data?.agents || []}
        />
      </GlassCard>

      <GlassCard className="p-0">
        <div className="p-4 border-b border-white/[0.04]">
          <h3 className="font-display font-semibold">Live Allocations</h3>
        </div>
        <DataTable
          className="border-0 rounded-none"
          columns={[
            { key: "username", header: "Agent", render: (r) => r.username || `#${r.user_id}` },
            { key: "phone_number", header: "Number", render: (r) => <span className="font-mono">{r.phone_number}</span> },
            { key: "provider", header: "Provider", render: (r) => <span className="uppercase text-xs">{r.provider}</span> },
            { key: "operator", header: "Operator", render: (r) => r.operator || "—" },
            { key: "status", header: "Status" },
            { key: "allocated_at", header: "Time", render: (r) => new Date(r.allocated_at * 1000).toLocaleString() },
          ]}
          data={alloc?.allocations || []}
        />
      </GlassCard>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="glass-card border-white/10">
          <DialogHeader><DialogTitle>Edit Limits — {editing?.username}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Daily limit</label>
              <Input type="number" value={daily} onChange={(e) => setDaily(+e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Per-request limit</label>
              <Input type="number" value={perReq} onChange={(e) => setPerReq(+e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AdminAllocation;

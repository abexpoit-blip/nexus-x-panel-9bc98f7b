import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { DataTable } from "@/components/DataTable";
import { GlassCard } from "@/components/GlassCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Users, Plus, Pencil, Trash2, Search, Wallet, UserCheck, UserX, Power, LogIn } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { GradientMesh, PageHeader, PremiumKpiCard } from "@/components/premium";

type AgentForm = {
  id?: number;
  username: string;
  password?: string;
  full_name?: string;
  phone?: string;
  telegram?: string;
  daily_limit?: number;
  per_request_limit?: number;
  status?: string;
};

const empty: AgentForm = { username: "", password: "", daily_limit: 100, per_request_limit: 5, status: "active" };

const AdminAgents = () => {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { loginAsAgent } = useAuth();
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "suspended">("all");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<AgentForm>(empty);
  const [topup, setTopup] = useState<{ id: number; username: string } | null>(null);
  const [topupAmount, setTopupAmount] = useState<string>("");
  const [topupNote, setTopupNote] = useState<string>("");

  const { data, isLoading } = useQuery({ queryKey: ["agents"], queryFn: () => api.admin.agents() });

  const save = useMutation({
    mutationFn: async (f: AgentForm) => {
      if (f.id) {
        const { id, password, ...rest } = f;
        return api.admin.updateAgent(id, password ? { ...rest, password } : rest);
      }
      return api.admin.createAgent(f);
    },
    onSuccess: () => {
      toast.success(form.id ? "Agent updated" : "Agent created");
      qc.invalidateQueries({ queryKey: ["agents"] });
      setOpen(false);
      setForm(empty);
    },
    onError: (e: any) => toast.error(e.message || "Failed"),
  });

  const del = useMutation({
    mutationFn: (id: number) => api.admin.deleteAgent(id),
    onSuccess: () => {
      toast.success("Agent deleted");
      qc.invalidateQueries({ queryKey: ["agents"] });
    },
  });

  const toggleStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      api.admin.updateAgent(id, { status: status === "active" ? "suspended" : "active" }),
    onSuccess: () => {
      toast.success("Status updated");
      qc.invalidateQueries({ queryKey: ["agents"] });
    },
  });

  const topupMutation = useMutation({
    mutationFn: (body: { user_id: number; amount_bdt: number; note?: string }) =>
      api.payments.topup({ ...body, method: "admin", reference: "manual-topup" }),
    onSuccess: () => {
      toast.success(`Topped up ৳${topupAmount} for ${topup?.username}`);
      qc.invalidateQueries({ queryKey: ["agents"] });
      setTopup(null);
      setTopupAmount("");
      setTopupNote("");
    },
    onError: (e: any) => toast.error(e.message || "Top-up failed"),
  });

  const allAgents = data?.agents || [];
  const stats = useMemo(() => ({
    total: allAgents.length,
    active: allAgents.filter((a) => a.status === "active").length,
    suspended: allAgents.filter((a) => a.status === "suspended").length,
  }), [allAgents]);

  const rows = allAgents.filter((a) => {
    const matchesSearch = !q || a.username.toLowerCase().includes(q.toLowerCase()) || a.full_name?.toLowerCase().includes(q.toLowerCase());
    const matchesStatus = statusFilter === "all" || a.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <div className="relative space-y-6">
      <GradientMesh variant="default" />
      <PageHeader
        eyebrow="Team Management"
        title="Agents"
        description="Manage all agent accounts, balances and limits"
        icon={<Users className="w-5 h-5 text-neon-cyan" />}
        actions={
          <Button onClick={() => { setForm(empty); setOpen(true); }} className="bg-gradient-to-r from-primary to-neon-magenta text-primary-foreground font-semibold hover:opacity-90 border-0">
            <Plus className="w-4 h-4 mr-2" /> New Agent
          </Button>
        }
      />

      {/* KPI strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <PremiumKpiCard label="Total Agents" value={stats.total} icon={Users} tone="cyan" />
        <PremiumKpiCard label="Active" value={stats.active} icon={UserCheck} tone="green" />
        <PremiumKpiCard label="Suspended" value={stats.suspended} icon={UserX} tone="magenta" />
      </div>

      <GlassCard className="p-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search username or name…" className="pl-9 bg-white/[0.04] border-white/[0.08]" />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
            className="h-10 px-3 rounded-md bg-white/[0.04] border border-white/[0.08] text-sm text-foreground"
          >
            <option value="all">All status</option>
            <option value="active">Active only</option>
            <option value="suspended">Suspended only</option>
          </select>
        </div>
      </GlassCard>

      <DataTable
        columns={[
          { key: "username", header: "Username", render: (r) => <span className="font-semibold">{r.username}</span> },
          { key: "full_name", header: "Name", render: (r) => r.full_name || "—" },
          { key: "balance", header: "Balance", render: (r) => <span className="font-mono text-neon-green">৳{r.balance.toFixed(2)}</span> },
          { key: "otp_count", header: "OTPs", render: (r) => r.otp_count.toLocaleString() },
          { key: "daily_limit", header: "Daily limit", render: (r) => r.daily_limit },
          { key: "per_request_limit", header: "Per req", render: (r) => r.per_request_limit },
          {
            key: "status",
            header: "Status",
            render: (r) => (
              <span className={cn(
                "px-2 py-0.5 rounded text-xs font-semibold uppercase",
                r.status === "active" ? "bg-neon-green/15 text-neon-green" : "bg-destructive/15 text-destructive"
              )}>{r.status}</span>
            ),
          },
          {
            key: "actions",
            header: "",
            render: (r) => (
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={async () => {
                    if (!confirm(`Login as ${r.username}? Your admin session will be preserved — exit anytime from the top banner.`)) return;
                    const ok = await loginAsAgent(r.id);
                    if (ok) {
                      toast.success(`Now viewing as ${r.username}`);
                      navigate("/agent/dashboard");
                    } else {
                      toast.error("Login as agent failed");
                    }
                  }}
                  className="text-neon-cyan hover:underline text-xs flex items-center gap-1"
                  title="Login as this agent (impersonate)"
                  disabled={r.status !== "active"}
                >
                  <LogIn className="w-3 h-3" /> Login as
                </button>
                <button
                  onClick={() => { setTopup({ id: r.id, username: r.username }); setTopupAmount(""); setTopupNote(""); }}
                  className="text-neon-green hover:underline text-xs flex items-center gap-1"
                  title="Top up balance"
                >
                  <Wallet className="w-3 h-3" /> Top-up
                </button>
                <button
                  onClick={() => toggleStatus.mutate({ id: r.id, status: r.status })}
                  className={cn("hover:underline text-xs flex items-center gap-1", r.status === "active" ? "text-neon-amber" : "text-neon-green")}
                  title={r.status === "active" ? "Suspend" : "Activate"}
                >
                  <Power className="w-3 h-3" /> {r.status === "active" ? "Suspend" : "Activate"}
                </button>
                <button onClick={() => { setForm({ ...r, password: "" }); setOpen(true); }} className="text-primary hover:underline text-xs flex items-center gap-1">
                  <Pencil className="w-3 h-3" /> Edit
                </button>
                <button onClick={() => { if (confirm(`Delete ${r.username}? This will cascade-delete all their data.`)) del.mutate(r.id); }} className="text-destructive hover:underline text-xs flex items-center gap-1">
                  <Trash2 className="w-3 h-3" /> Delete
                </button>
              </div>
            ),
          },
        ]}
        data={rows}
      />
      {isLoading && <p className="text-center text-muted-foreground text-sm">Loading…</p>}

      {/* Create / Edit dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="glass-card border-white/10">
          <DialogHeader>
            <DialogTitle>{form.id ? "Edit Agent" : "New Agent"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Field label="Username"><Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} disabled={!!form.id} /></Field>
            <Field label={form.id ? "New password (leave blank to keep)" : "Password"}>
              <Input type="password" value={form.password || ""} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </Field>
            <Field label="Full name"><Input value={form.full_name || ""} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Phone"><Input value={form.phone || ""} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
              <Field label="Telegram"><Input value={form.telegram || ""} onChange={(e) => setForm({ ...form, telegram: e.target.value })} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Daily limit"><Input type="number" value={form.daily_limit ?? 0} onChange={(e) => setForm({ ...form, daily_limit: +e.target.value })} /></Field>
              <Field label="Per-request limit"><Input type="number" value={form.per_request_limit ?? 0} onChange={(e) => setForm({ ...form, per_request_limit: +e.target.value })} /></Field>
            </div>
            <Field label="Status">
              <select value={form.status || "active"} onChange={(e) => setForm({ ...form, status: e.target.value })} className="w-full h-10 px-3 rounded-md bg-white/[0.04] border border-white/[0.08]">
                <option value="active">active</option>
                <option value="suspended">suspended</option>
              </select>
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => save.mutate(form)} disabled={save.isPending}>{save.isPending ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Top-up dialog */}
      <Dialog open={!!topup} onOpenChange={(v) => !v && setTopup(null)}>
        <DialogContent className="glass-card border-white/10">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wallet className="w-5 h-5 text-neon-green" /> Top-up — {topup?.username}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Field label="Amount (BDT)">
              <Input type="number" value={topupAmount} onChange={(e) => setTopupAmount(e.target.value)} placeholder="500" autoFocus />
            </Field>
            <Field label="Note (optional)">
              <Input value={topupNote} onChange={(e) => setTopupNote(e.target.value)} placeholder="Manual top-up by admin" />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTopup(null)}>Cancel</Button>
            <Button
              onClick={() => {
                const amt = Number(topupAmount);
                if (!amt || amt <= 0) return toast.error("Enter a valid amount");
                if (!topup) return;
                topupMutation.mutate({ user_id: topup.id, amount_bdt: amt, note: topupNote || undefined });
              }}
              disabled={topupMutation.isPending}
              className="bg-neon-green text-background hover:opacity-90"
            >
              {topupMutation.isPending ? "Processing…" : "Confirm Top-up"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="space-y-1.5">
    <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</label>
    {children}
  </div>
);

export default AdminAgents;

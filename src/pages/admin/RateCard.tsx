import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Rate } from "@/lib/api";
import { DataTable } from "@/components/DataTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tag, Plus, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { GradientMesh, PageHeader } from "@/components/premium";

const empty: Partial<Rate> & { agent_commission_percent?: number } = { provider: "msi", country_code: "", country_name: "", operator: "", price_bdt: 0, active: 1, agent_commission_percent: 60 };

const AdminRateCard = () => {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Partial<Rate>>(empty);

  const { data, isLoading } = useQuery({ queryKey: ["rates"], queryFn: () => api.rates.list() });

  const save = useMutation({
    mutationFn: async (f: Partial<Rate>) => f.id ? api.rates.update(f.id, f) : api.rates.create(f),
    onSuccess: () => {
      toast.success("Saved");
      qc.invalidateQueries({ queryKey: ["rates"] });
      setOpen(false);
      setForm(empty);
    },
    onError: (e: any) => toast.error(e.message),
  });

  const del = useMutation({
    mutationFn: (id: number) => api.rates.remove(id),
    onSuccess: () => { toast.success("Deleted"); qc.invalidateQueries({ queryKey: ["rates"] }); },
  });

  return (
    <div className="relative space-y-6">
      <GradientMesh variant="default" />
      <PageHeader
        eyebrow="Pricing"
        title="Rate Card"
        description="Pricing per provider, country and operator (BDT)"
        icon={<Tag className="w-5 h-5 text-neon-magenta" />}
        actions={
          <Button onClick={() => { setForm(empty); setOpen(true); }} className="bg-gradient-to-r from-primary to-neon-magenta text-primary-foreground font-semibold hover:opacity-90 border-0">
            <Plus className="w-4 h-4 mr-2" /> New Rate
          </Button>
        }
      />

      <DataTable
        columns={[
          { key: "provider", header: "Provider", render: (r) => <span className="uppercase text-xs">{r.provider}</span> },
          { key: "country_name", header: "Country", render: (r) => `${r.country_name || ""} ${r.country_code ? `(${r.country_code})` : ""}` },
          { key: "operator", header: "Operator", render: (r) => r.operator || "—" },
          { key: "price_bdt", header: "Price", render: (r) => <span className="font-mono text-neon-green font-bold">৳{r.price_bdt.toFixed(2)}</span> },
          {
            key: "commission",
            header: "Agent Commission",
            render: (r) => {
              const pct = (r as any).agent_commission_percent ?? 60;
              const isZero = Number(pct) === 0;
              return (
                <span className={cn(
                  "inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-semibold",
                  isZero
                    ? "bg-neon-amber/15 text-neon-amber border border-neon-amber/30"
                    : "bg-primary/15 text-primary"
                )}>
                  {isZero ? "⚠ Zero-payout" : `${pct}% · ৳${((r.price_bdt * pct) / 100).toFixed(2)}`}
                </span>
              );
            },
          },
          {
            key: "active",
            header: "Status",
            render: (r) => (
              <span className={cn("px-2 py-0.5 rounded text-xs font-semibold uppercase",
                r.active ? "bg-neon-green/15 text-neon-green" : "bg-muted text-muted-foreground"
              )}>{r.active ? "active" : "inactive"}</span>
            ),
          },
          {
            key: "actions",
            header: "",
            render: (r) => (
              <div className="flex gap-2">
                <button onClick={() => { setForm(r); setOpen(true); }} className="text-primary hover:underline text-xs flex items-center gap-1">
                  <Pencil className="w-3 h-3" /> Edit
                </button>
                <button
                  onClick={() => {
                    const pct = (r as any).agent_commission_percent ?? 60;
                    const next = Number(pct) === 0 ? 60 : 0;
                    save.mutate({ ...r, agent_commission_percent: next } as any);
                  }}
                  className={cn("text-xs flex items-center gap-1 hover:underline",
                    Number((r as any).agent_commission_percent ?? 60) === 0 ? "text-neon-green" : "text-neon-amber"
                  )}
                  title="Quick toggle: set commission to 0% (no payout) or back to 60%"
                >
                  {Number((r as any).agent_commission_percent ?? 60) === 0 ? "Enable payout" : "Set 0%"}
                </button>
                <button onClick={() => { if (confirm("Delete rate?")) del.mutate(r.id); }} className="text-destructive hover:underline text-xs flex items-center gap-1">
                  <Trash2 className="w-3 h-3" /> Delete
                </button>
              </div>
            ),
          },
        ]}
        data={data?.rates || []}
      />
      {isLoading && <p className="text-center text-muted-foreground text-sm">Loading…</p>}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="glass-card border-white/10">
          <DialogHeader><DialogTitle>{form.id ? "Edit Rate" : "New Rate"}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Field label="Provider">
              <select value={form.provider || "msi"} onChange={(e) => setForm({ ...form, provider: e.target.value })} className="w-full h-10 px-3 rounded-md bg-white/[0.04] border border-white/[0.08]">
                <option value="msi">MSI</option>
                <option value="acchub">AccHub</option>
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Country code"><Input value={form.country_code || ""} onChange={(e) => setForm({ ...form, country_code: e.target.value })} /></Field>
              <Field label="Country name"><Input value={form.country_name || ""} onChange={(e) => setForm({ ...form, country_name: e.target.value })} /></Field>
            </div>
            <Field label="Operator"><Input value={form.operator || ""} onChange={(e) => setForm({ ...form, operator: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Provider Price (৳)"><Input type="number" step="0.01" value={form.price_bdt ?? 0} onChange={(e) => setForm({ ...form, price_bdt: +e.target.value })} /></Field>
              <Field label="Agent Commission (%)">
                <Input type="number" min="0" max="100" step="1"
                  value={(form as any).agent_commission_percent ?? 60}
                  onChange={(e) => setForm({ ...form, agent_commission_percent: +e.target.value } as any)} />
              </Field>
            </div>
            <div className="text-xs text-muted-foreground -mt-1 pl-1">
              Agent earns: <span className="text-neon-green font-mono">৳{(((form.price_bdt ?? 0) * ((form as any).agent_commission_percent ?? 60)) / 100).toFixed(2)}</span> per successful OTP
            </div>
            <Field label="Active">
              <select value={String(form.active ?? 1)} onChange={(e) => setForm({ ...form, active: +e.target.value })} className="w-full h-10 px-3 rounded-md bg-white/[0.04] border border-white/[0.08]">
                <option value="1">Active</option>
                <option value="0">Inactive</option>
              </select>
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              onClick={() => {
                const payload: any = {
                  provider: form.provider,
                  country_code: form.country_code || null,
                  country_name: form.country_name || null,
                  operator: form.operator || null,
                  price_bdt: Number(form.price_bdt) || 0,
                  agent_commission_percent: Number((form as any).agent_commission_percent) || 0,
                  active: !!form.active,
                };
                if (form.id) payload.id = form.id;
                save.mutate(payload);
              }}
              disabled={save.isPending}
            >{save.isPending ? "Saving…" : "Save"}</Button>
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

export default AdminRateCard;

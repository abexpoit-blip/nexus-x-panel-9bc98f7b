import { useMemo, useState } from "react";
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

// Global default per provider — no country/operator. Backend commission lookup
// will fall back to this row whenever a more specific match doesn't exist.
// Provider id is filled in from the live registry once it loads.
const emptyTemplate: Partial<Rate> & { agent_commission_percent?: number } = {
  provider: "", country_code: null as any, country_name: null as any,
  operator: null as any, price_bdt: 0, active: 1, agent_commission_percent: 60,
};

// Friendly "Server X" letters cycle A-Z then fall back to the raw id.
const SERVER_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// Token classes rotate so each new provider gets a distinct chip color
// without hard-coding ids — keeps the UI auto-extending for new bots.
const PROVIDER_CHIP_TOKENS = [
  "bg-neon-cyan/15 text-neon-cyan",
  "bg-neon-magenta/15 text-neon-magenta",
  "bg-neon-green/15 text-neon-green",
  "bg-neon-amber/15 text-neon-amber",
  "bg-neon-purple/15 text-neon-purple",
  "bg-primary/15 text-primary",
];

const AdminRateCard = () => {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Partial<Rate>>(emptyTemplate);

  const { data, isLoading } = useQuery({ queryKey: ["rates"], queryFn: () => api.rates.list() });
  // Live provider registry — every backend bot auto-appears here.
  const { data: provData } = useQuery({
    queryKey: ["provider-status"],
    queryFn: () => api.admin.providerStatus(),
    staleTime: 30_000,
  });

  // Map provider id → { letter, label, chip } so chip + dropdown share one source.
  const providerMeta = useMemo(() => {
    const list = provData?.providers || [];
    const map = new Map<string, { letter: string; label: string; chip: string; name: string }>();
    list.forEach((p, i) => {
      const letter = SERVER_LETTERS[i] || String(i + 1);
      map.set(p.id, {
        letter,
        label: `Server ${letter}`,
        name: p.name || p.id,
        chip: PROVIDER_CHIP_TOKENS[i % PROVIDER_CHIP_TOKENS.length],
      });
    });
    return map;
  }, [provData]);
  const providerList = provData?.providers || [];
  const defaultProviderId = providerList[0]?.id || "";

  const empty = useMemo<Partial<Rate> & { agent_commission_percent?: number }>(
    () => ({ ...emptyTemplate, provider: defaultProviderId }),
    [defaultProviderId],
  );

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
          {
            key: "provider",
            header: "Server",
            render: (r) => {
              const meta = providerMeta.get(r.provider);
              return (
                <span
                  title={meta?.name || r.provider}
                  className={cn(
                    "inline-flex items-center px-2 py-0.5 rounded text-xs font-bold uppercase",
                    meta?.chip || "bg-muted text-muted-foreground",
                  )}
                >
                  {meta?.label || r.provider}
                </span>
              );
            },
          },
          {
            key: "scope",
            header: "Scope",
            render: (r) => {
              const hasCountry = !!(r.country_code || r.country_name);
              const hasOperator = !!r.operator;
              if (!hasCountry && !hasOperator) {
                return <span className="text-xs text-neon-amber font-semibold">⚡ Global default</span>;
              }
              return (
                <span className="text-xs text-muted-foreground">
                  {r.country_name || r.country_code || "any"}
                  {hasOperator && <span className="text-foreground"> · {r.operator}</span>}
                </span>
              );
            },
          },
          { key: "price_bdt", header: "Price / OTP", render: (r) => <span className="font-mono text-neon-green font-bold">৳{r.price_bdt.toFixed(2)}</span> },
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
              <select
                value={form.provider || defaultProviderId}
                onChange={(e) => setForm({ ...form, provider: e.target.value })}
                className="w-full h-10 px-3 rounded-md bg-white/[0.04] border border-white/[0.08]"
              >
                {providerList.length === 0 && <option value="">Loading providers…</option>}
                {providerList.map((p, i) => {
                  const letter = SERVER_LETTERS[i] || String(i + 1);
                  return (
                    <option key={p.id} value={p.id}>
                      Server {letter} ({p.name || p.id})
                    </option>
                  );
                })}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Provider Price (৳)">
                <Input type="number" step="0.01" value={form.price_bdt ?? 0} onChange={(e) => setForm({ ...form, price_bdt: +e.target.value })} />
              </Field>
              <Field label="Agent Commission (%)">
                <Input type="number" min="0" max="100" step="1"
                  value={(form as any).agent_commission_percent ?? 60}
                  onChange={(e) => setForm({ ...form, agent_commission_percent: +e.target.value } as any)} />
              </Field>
            </div>
            <div className="text-xs text-muted-foreground -mt-1 pl-1">
              Agent earns: <span className="text-neon-green font-mono">৳{(((form.price_bdt ?? 0) * ((form as any).agent_commission_percent ?? 60)) / 100).toFixed(2)}</span> per successful OTP — <span className="text-neon-cyan">applies to ALL countries/operators on this provider</span>
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

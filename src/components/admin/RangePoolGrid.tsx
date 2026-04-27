import { useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Layers, Edit3, Save, Trash2, Clock, Hash, PowerOff, Power,
  Tag,
} from "lucide-react";

export type RangeRow = {
  name: string;
  count: number;
  last_added: number;
  first_added?: number;
  custom_name: string | null;
  tag_color: string | null;
  priority: number | null;
  request_override: number | null;
  notes: string | null;
  disabled: number | null;
  service_tag: string | null;
};

type Provider = "numpanel" | "ims" | "msi" | "iprn_sms" | "iprn_sms_v2" | "seven1tel";

const TAG_COLORS = [
  { key: "cyan",   cls: "from-neon-cyan/20 to-neon-cyan/5 border-neon-cyan/40 text-neon-cyan",        swatch: "bg-neon-cyan" },
  { key: "green",  cls: "from-neon-green/20 to-neon-green/5 border-neon-green/40 text-neon-green",    swatch: "bg-neon-green" },
  { key: "amber",  cls: "from-neon-amber/20 to-neon-amber/5 border-neon-amber/40 text-neon-amber",    swatch: "bg-neon-amber" },
  { key: "purple", cls: "from-neon-purple/20 to-neon-purple/5 border-neon-purple/40 text-neon-purple",swatch: "bg-neon-purple" },
  { key: "pink",   cls: "from-pink-500/20 to-pink-500/5 border-pink-500/40 text-pink-400",            swatch: "bg-pink-400" },
  { key: "blue",   cls: "from-blue-500/20 to-blue-500/5 border-blue-500/40 text-blue-400",            swatch: "bg-blue-400" },
];
const colorClass = (key: string | null | undefined) =>
  TAG_COLORS.find(c => c.key === key)?.cls ||
  "from-white/[0.04] to-white/[0.01] border-white/[0.08] text-foreground";

const SERVICE_TAGS = [
  { key: "facebook",  label: "Facebook",  cls: "bg-blue-600/20 text-blue-300 border-blue-500/40", emoji: "📘" },
  { key: "whatsapp",  label: "WhatsApp",  cls: "bg-green-600/20 text-green-300 border-green-500/40", emoji: "🟢" },
  { key: "telegram",  label: "Telegram",  cls: "bg-sky-500/20 text-sky-300 border-sky-400/40", emoji: "✈️" },
  { key: "instagram", label: "Instagram", cls: "bg-pink-500/20 text-pink-300 border-pink-500/40", emoji: "📷" },
  { key: "twitter",   label: "Twitter/X", cls: "bg-slate-500/20 text-slate-200 border-slate-400/40", emoji: "𝕏" },
  { key: "tiktok",    label: "TikTok",    cls: "bg-rose-500/20 text-rose-300 border-rose-500/40", emoji: "🎵" },
  { key: "google",    label: "Google",    cls: "bg-amber-500/20 text-amber-300 border-amber-500/40", emoji: "G" },
  { key: "other",     label: "Other",     cls: "bg-white/10 text-muted-foreground border-white/20", emoji: "•" },
];
const serviceMeta = (key: string | null | undefined) =>
  SERVICE_TAGS.find(s => s.key === key) || null;

function apiSave(provider: Provider, body: Record<string, unknown>) {
  if (provider === "numpanel") return api.admin.numpanelRangeMetaSave(body as Parameters<typeof api.admin.numpanelRangeMetaSave>[0]);
  if (provider === "ims") return api.admin.imsRangeMetaSave(body as Parameters<typeof api.admin.imsRangeMetaSave>[0]);
  if (provider === "msi") return api.admin.msiRangeMetaSave(body as Parameters<typeof api.admin.msiRangeMetaSave>[0]);
  if (provider === "iprn_sms") return api.admin.iprnSmsRangeMetaSave(body as Parameters<typeof api.admin.iprnSmsRangeMetaSave>[0]);
  if (provider === "iprn_sms_v2") return api.admin.iprnSmsV2RangeMetaSave(body as Parameters<typeof api.admin.iprnSmsV2RangeMetaSave>[0]);
  return api.admin.seven1telRangeMetaSave(body as Parameters<typeof api.admin.seven1telRangeMetaSave>[0]);
}
function apiDelete(provider: Provider, prefix: string) {
  if (provider === "numpanel") return api.admin.numpanelRangeMetaDelete(prefix);
  if (provider === "ims") return api.admin.imsRangeMetaDelete(prefix);
  if (provider === "msi") return api.admin.msiRangeMetaDelete(prefix);
  if (provider === "iprn_sms") return api.admin.iprnSmsRangeMetaDelete(prefix);
  if (provider === "iprn_sms_v2") return api.admin.iprnSmsV2RangeMetaDelete(prefix);
  return api.admin.seven1telRangeMetaDelete(prefix);
}

const RangeCard = ({ r, provider, onChanged }: { r: RangeRow; provider: Provider; onChanged: () => void }) => {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(r.custom_name || "");
  const [color, setColor] = useState(r.tag_color || "");
  const [priority, setPriority] = useState<string>(r.priority != null ? String(r.priority) : "");
  const [override, setOverride] = useState<string>(r.request_override != null ? String(r.request_override) : "");
  const [notes, setNotes] = useState(r.notes || "");
  const [serviceTag, setServiceTag] = useState<string>(r.service_tag || "");
  const [busy, setBusy] = useState(false);

  const isDisabled = !!r.disabled;
  const display = r.custom_name || r.name;
  const accent = colorClass(r.tag_color);
  const ageMin = r.last_added ? Math.max(0, Math.floor((Date.now()/1000 - r.last_added) / 60)) : null;
  const stale = ageMin != null && ageMin > 30;
  const svc = serviceMeta(r.service_tag);

  const save = async () => {
    setBusy(true);
    try {
      await apiSave(provider, {
        range_prefix: r.name,
        custom_name: name.trim() || null,
        tag_color: color || null,
        priority: priority === "" ? null : Number(priority),
        request_override: override === "" ? null : Number(override),
        notes: notes.trim() || null,
        service_tag: serviceTag || null,
      });
      toast.success("Range updated");
      setEditing(false);
      onChanged();
    } catch (e) {
      toast.error("Save failed: " + (e as Error).message);
    } finally { setBusy(false); }
  };

  const toggleDisabled = async () => {
    setBusy(true);
    try {
      await apiSave(provider, { range_prefix: r.name, disabled: !isDisabled });
      toast.success(isDisabled ? "Range enabled" : "Range disabled — bot will skip this range");
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally { setBusy(false); }
  };

  const reset = async () => {
    if (!confirm(`Reset all customization for ${r.name}?`)) return;
    try {
      await apiDelete(provider, r.name);
      toast.success("Reset");
      onChanged();
    } catch (e) { toast.error((e as Error).message); }
  };

  return (
    <div className={cn(
      "relative overflow-hidden rounded-xl border bg-gradient-to-br p-4 transition-all hover:scale-[1.01] hover:shadow-lg",
      accent,
      isDisabled && "opacity-50 grayscale",
    )}>
      {isDisabled && (
        <div className="absolute top-2 right-2 z-10 px-1.5 py-0.5 rounded bg-destructive/30 text-destructive text-[9px] font-bold uppercase tracking-wider border border-destructive/40">
          Disabled
        </div>
      )}
      <div className="absolute inset-0 opacity-30 pointer-events-none">
        <div className="absolute -top-12 -right-12 w-32 h-32 rounded-full bg-current blur-3xl opacity-20" />
      </div>

      <div className="relative">
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
              {r.priority ? (
                <span className="text-[9px] font-bold uppercase tracking-wider bg-current/15 px-1.5 py-0.5 rounded">
                  P{r.priority}
                </span>
              ) : null}
              {svc && (
                <span className={cn("text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border", svc.cls)}>
                  <span className="mr-1">{svc.emoji}</span>{svc.label}
                </span>
              )}
              <h4 className="font-bold text-sm truncate">{display}</h4>
            </div>
            {r.custom_name && (
              <div className="text-[10px] font-mono text-muted-foreground truncate">{r.name}</div>
            )}
          </div>
          <div className="shrink-0 flex items-center gap-0.5">
            <button
              onClick={toggleDisabled}
              disabled={busy}
              className={cn(
                "p-1 rounded transition",
                isDisabled
                  ? "text-neon-green hover:bg-neon-green/10"
                  : "text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              )}
              title={isDisabled ? "Enable range" : "Disable range (bot skips)"}
            >
              {isDisabled ? <Power className="w-3.5 h-3.5" /> : <PowerOff className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={() => setEditing(v => !v)}
              className="p-1 rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition"
              title="Customize"
            >
              <Edit3 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="flex items-baseline gap-2 mb-2">
          <span className="text-3xl font-black tabular-nums">{r.count}</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">in pool</span>
        </div>

        <div className="flex items-center gap-3 text-[10px] text-muted-foreground flex-wrap">
          <div className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            <span className={cn(stale && "text-neon-amber font-semibold")}>
              {ageMin == null ? "—" : ageMin < 60 ? `${ageMin}m ago` : `${Math.floor(ageMin/60)}h ago`}
            </span>
          </div>
          {r.request_override != null && provider === "numpanel" && (
            <div className="flex items-center gap-1">
              <Hash className="w-3 h-3" />
              <span className="font-mono">REQ ×{r.request_override}</span>
            </div>
          )}
        </div>

        {r.notes && !editing && (
          <div className="mt-2 text-[10px] text-muted-foreground italic line-clamp-2">{r.notes}</div>
        )}

        {editing && (
          <div className="mt-3 pt-3 border-t border-white/10 space-y-2">
            <input
              value={name} onChange={e => setName(e.target.value)}
              placeholder="Custom name (e.g. Movistar TF12)"
              className="w-full bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs"
            />
            <div>
              <div className="flex items-center gap-1 text-[10px] uppercase text-muted-foreground mb-1">
                <Tag className="w-3 h-3" />Service tag
              </div>
              <div className="flex flex-wrap gap-1">
                {SERVICE_TAGS.map(s => (
                  <button
                    key={s.key}
                    onClick={() => setServiceTag(serviceTag === s.key ? "" : s.key)}
                    className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded border font-semibold transition",
                      s.cls,
                      serviceTag === s.key ? "ring-1 ring-white scale-105" : "opacity-50 hover:opacity-100"
                    )}
                  >
                    <span className="mr-0.5">{s.emoji}</span>{s.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-[10px] uppercase text-muted-foreground mr-1">Color:</span>
              {TAG_COLORS.map(c => (
                <button
                  key={c.key}
                  onClick={() => setColor(c.key)}
                  className={cn(
                    "w-5 h-5 rounded-full border-2 transition",
                    c.swatch,
                    color === c.key ? "ring-2 ring-white scale-110" : "opacity-60 hover:opacity-100"
                  )}
                  title={c.key}
                />
              ))}
              <button
                onClick={() => setColor("")}
                className={cn(
                  "w-5 h-5 rounded-full border-2 border-white/30 bg-transparent text-[10px]",
                  color === "" ? "ring-2 ring-white" : "opacity-60"
                )}
              >×</button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[9px] uppercase text-muted-foreground">Priority</label>
                <input
                  type="number" value={priority} onChange={e => setPriority(e.target.value)}
                  placeholder="0"
                  className="w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-xs font-mono"
                />
              </div>
              {provider === "numpanel" && (
                <div>
                  <label className="text-[9px] uppercase text-muted-foreground">REQ ×</label>
                  <input
                    type="number" value={override} onChange={e => setOverride(e.target.value)}
                    placeholder="default"
                    className="w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-xs font-mono"
                  />
                </div>
              )}
            </div>
            <textarea
              value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="Notes (optional)"
              rows={2}
              className="w-full bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs resize-none"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={save} disabled={busy}
                className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-neon-cyan/20 border border-neon-cyan/40 text-neon-cyan text-xs font-semibold hover:bg-neon-cyan/30 transition disabled:opacity-50"
              >
                <Save className="w-3 h-3" />{busy ? "…" : "Save"}
              </button>
              <button
                onClick={reset}
                className="px-2 py-1.5 rounded bg-destructive/15 border border-destructive/30 text-destructive text-xs hover:bg-destructive/25 transition"
                title="Reset"
              >
                <Trash2 className="w-3 h-3" />
              </button>
              <button
                onClick={() => setEditing(false)}
                className="px-2 py-1.5 rounded border border-white/10 text-xs text-muted-foreground hover:text-foreground"
              >Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export const RangePoolGrid = ({
  ranges, totalActive, totalUsed = 0, provider, onChanged,
}: {
  ranges: RangeRow[]; totalActive: number; totalUsed?: number;
  provider: Provider; onChanged: () => void;
}) => {
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"priority" | "count" | "name" | "age">("priority");
  const [filterService, setFilterService] = useState<string>("");
  const [showDisabled, setShowDisabled] = useState(true);

  const totalPool = ranges.reduce((a, r) => a + r.count, 0);
  const enabledCount = ranges.filter(r => !r.disabled).length;
  const disabledCount = ranges.length - enabledCount;

  const filtered = ranges
    .filter(r => {
      if (!showDisabled && r.disabled) return false;
      if (filterService && r.service_tag !== filterService) return false;
      if (!search) return true;
      const q = search.toLowerCase();
      return r.name.toLowerCase().includes(q) || (r.custom_name?.toLowerCase().includes(q) ?? false);
    })
    .sort((a, b) => {
      if (sortBy === "count") return b.count - a.count;
      if (sortBy === "name") return (a.custom_name || a.name).localeCompare(b.custom_name || b.name);
      if (sortBy === "age") return (b.last_added || 0) - (a.last_added || 0);
      return (b.priority || 0) - (a.priority || 0) || b.count - a.count;
    });

  return (
    <div className="glass-card border border-white/[0.06] rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Layers className="w-4 h-4 text-neon-cyan" />
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Range Pool Manager
          </h3>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-neon-cyan/15 text-neon-cyan font-bold">
            {enabledCount} active
          </span>
          {disabledCount > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-destructive/15 text-destructive font-bold">
              {disabledCount} disabled
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search…"
            className="bg-white/[0.04] border border-white/[0.08] rounded px-2 py-1 text-xs w-32"
          />
          <select
            value={filterService} onChange={e => setFilterService(e.target.value)}
            className="bg-white/[0.04] border border-white/[0.08] rounded px-2 py-1 text-xs"
          >
            <option value="">All services</option>
            {SERVICE_TAGS.map(s => <option key={s.key} value={s.key}>{s.emoji} {s.label}</option>)}
          </select>
          <select
            value={sortBy} onChange={e => setSortBy(e.target.value as typeof sortBy)}
            className="bg-white/[0.04] border border-white/[0.08] rounded px-2 py-1 text-xs"
          >
            <option value="priority">Priority</option>
            <option value="count">Count</option>
            <option value="name">Name</option>
            <option value="age">Newest</option>
          </select>
          <label className="flex items-center gap-1 text-[10px] text-muted-foreground cursor-pointer">
            <input
              type="checkbox" checked={showDisabled}
              onChange={e => setShowDisabled(e.target.checked)}
              className="accent-neon-cyan"
            />
            Show disabled
          </label>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg border border-neon-cyan/30 bg-neon-cyan/5 p-3">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">Pool</div>
          <div className="text-2xl font-black text-neon-cyan tabular-nums">{totalPool}</div>
        </div>
        <div className="rounded-lg border border-neon-amber/30 bg-neon-amber/5 p-3">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">Active</div>
          <div className="text-2xl font-black text-neon-amber tabular-nums">{totalActive}</div>
        </div>
        <div className="rounded-lg border border-neon-green/30 bg-neon-green/5 p-3">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">Used</div>
          <div className="text-2xl font-black text-neon-green tabular-nums">{totalUsed}</div>
        </div>
      </div>

      {filtered.length ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-h-[600px] overflow-y-auto scrollbar-none pr-1">
          {filtered.map(r => (
            <RangeCard key={r.name} r={r} provider={provider} onChanged={onChanged} />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-white/10 py-8 text-center">
          <p className="text-xs text-muted-foreground italic">
            {ranges.length === 0
              ? "Pool empty — start the bot or run Sync Live"
              : "No ranges match filter"}
          </p>
        </div>
      )}
    </div>
  );
};
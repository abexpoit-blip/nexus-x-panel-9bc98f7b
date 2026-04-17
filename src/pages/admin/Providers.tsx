import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GlassCard } from "@/components/GlassCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Settings, CheckCircle, XCircle, Wifi, Server, Wallet, AlertTriangle,
  Eye, EyeOff, Save, Loader2, KeyRound,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { GradientMesh, PageHeader } from "@/components/premium";
import { api, ProviderStatus } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

type CredsForm = { base_url: string; username: string; password: string; enabled?: boolean };

const AdminProviders = () => {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: liveStatus } = useQuery({
    queryKey: ["provider-status"],
    queryFn: () => api.admin.providerStatus(),
    refetchInterval: 15000,
  });

  const [editing, setEditing] = useState<string | null>(null);

  const providers = liveStatus?.providers || [];

  return (
    <div className="relative space-y-6">
      <GradientMesh variant="default" />
      <PageHeader
        eyebrow="Infrastructure"
        title="SMS Providers"
        description="Manage upstream IPRN/SMS API providers — credentials, balance, status"
        icon={<Server className="w-5 h-5 text-neon-cyan" />}
      />

      {providers.length === 0 && (
        <GlassCard>
          <div className="text-center py-8 text-muted-foreground">
            <Loader2 className="w-6 h-6 animate-spin mx-auto mb-3" />
            Loading provider status...
          </div>
        </GlassCard>
      )}

      <div className="space-y-4">
        {providers.map((p) => (
          <ProviderCard
            key={p.id}
            provider={p}
            isEditing={editing === p.id}
            onToggleEdit={() => setEditing(editing === p.id ? null : p.id)}
            onChanged={() => qc.invalidateQueries({ queryKey: ["provider-status"] })}
          />
        ))}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// Single provider row + editor
// ─────────────────────────────────────────────────────────────
function ProviderCard({
  provider: p,
  isEditing,
  onToggleEdit,
  onChanged,
}: {
  provider: ProviderStatus;
  isEditing: boolean;
  onToggleEdit: () => void;
  onChanged: () => void;
}) {
  const editable = p.id === "acchub" || p.id === "ims";
  const hasError = !!p.lastError;
  const isLive = p.configured && !hasError;

  return (
    <GlassCard className="!p-5">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="flex items-start gap-3">
          <div className={cn(
            "w-10 h-10 rounded-lg flex items-center justify-center",
            isLive ? "bg-neon-green/15" : hasError ? "bg-destructive/15" : "bg-muted/30"
          )}>
            <Server className={cn("w-5 h-5",
              isLive ? "text-neon-green" : hasError ? "text-destructive" : "text-muted-foreground")} />
          </div>
          <div>
            <h3 className="font-display font-semibold text-foreground flex items-center gap-2">
              {p.name}
              <span className={cn(
                "inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase",
                hasError ? "bg-destructive/15 text-destructive" :
                isLive ? "bg-neon-green/15 text-neon-green" : "bg-muted/30 text-muted-foreground"
              )}>
                {hasError ? <XCircle className="w-3 h-3" /> : <CheckCircle className="w-3 h-3" />}
                {hasError ? "Error" : isLive ? "Live" : "Not configured"}
              </span>
            </h3>
            <div className="text-xs text-muted-foreground space-y-0.5 mt-1">
              {p.username && <div>User: <span className="font-mono text-foreground/80">{p.username}</span></div>}
              {p.baseUrl && <div className="truncate max-w-md">URL: <span className="font-mono text-foreground/60">{p.baseUrl}</span></div>}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {p.balance !== null && p.balance !== undefined && (
            <div className="flex items-center gap-1.5 text-sm font-mono font-bold text-neon-green">
              <Wallet className="w-4 h-4" />
              ${p.balance.toFixed(2)}
              <span className="text-xs text-muted-foreground font-normal">{p.currency}</span>
            </div>
          )}
          {editable && (
            <Button
              size="sm"
              variant="outline"
              onClick={onToggleEdit}
              className="border-white/[0.1] hover:bg-white/[0.06]"
            >
              <Settings className="w-3.5 h-3.5 mr-1.5" />
              {isEditing ? "Close" : "Edit"}
            </Button>
          )}
        </div>
      </div>

      {hasError && (
        <div className="flex items-start gap-2 mb-3 p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-sm text-destructive">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="break-all font-mono text-xs">{p.lastError}</div>
        </div>
      )}

      {isEditing && p.id === "acchub" && <AcchubEditor onChanged={onChanged} />}
      {isEditing && p.id === "ims" && <ImsEditor onChanged={onChanged} />}
    </GlassCard>
  );
}

// ─────────────────────────────────────────────────────────────
// AccHub credentials editor
// ─────────────────────────────────────────────────────────────
function AcchubEditor({ onChanged }: { onChanged: () => void }) {
  const { toast } = useToast();
  const { data: creds, refetch } = useQuery({
    queryKey: ["acchub-credentials"],
    queryFn: () => api.admin.acchubCredentials(),
  });
  const [form, setForm] = useState<CredsForm>({ base_url: "", username: "", password: "" });
  const [showPwd, setShowPwd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (creds) setForm({ base_url: creds.base_url || "", username: creds.username || "", password: "" });
  }, [creds]);

  const save = async () => {
    setSaving(true);
    try {
      const body: Partial<CredsForm> = { base_url: form.base_url, username: form.username };
      if (form.password) body.password = form.password;
      await api.admin.acchubCredentialsSave(body);
      toast({ title: "Saved", description: "AccHub credentials updated. Testing login..." });
      setForm((f) => ({ ...f, password: "" }));
      await refetch();
      onChanged();
      await test(false);
    } catch (e) {
      toast({ title: "Save failed", description: (e as Error).message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  const test = async (showSuccess = true) => {
    setTesting(true);
    try {
      const r = await api.admin.acchubTest();
      if (r.ok) {
        toast({
          title: "✓ Login successful",
          description: r.status?.balance != null
            ? `Balance: $${r.status.balance.toFixed(2)} ${r.status.currency || ""}`
            : "Authenticated with AccHub",
        });
      } else {
        toast({ title: "Login failed", description: r.error || "Unknown error", variant: "destructive" });
      }
      onChanged();
    } catch (e) {
      if (showSuccess) toast({ title: "Test failed", description: (e as Error).message, variant: "destructive" });
    } finally { setTesting(false); }
  };

  return (
    <div className="border-t border-white/[0.06] pt-4 space-y-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <KeyRound className="w-4 h-4 text-neon-cyan" />
        AccHub Login Credentials
      </div>

      {creds && (
        <div className="text-xs text-muted-foreground bg-white/[0.02] rounded p-2 font-mono">
          Source — username: <span className="text-foreground/80">{creds.source.username}</span>
          {" · "}password: <span className="text-foreground/80">{creds.source.password}</span>
          {creds.has_password && <> · current: <span className="text-foreground/80">{creds.password_masked}</span></>}
        </div>
      )}

      <FormGrid form={form} setForm={setForm} showPwd={showPwd} setShowPwd={setShowPwd} hasPassword={!!creds?.has_password} />

      <div className="flex flex-wrap gap-2 pt-2">
        <SaveBtn onClick={save} loading={saving} disabled={saving || (!form.username && !form.password && !form.base_url)} />
        <Button variant="outline" onClick={() => test(true)} disabled={testing} className="border-white/[0.1] hover:bg-white/[0.06]">
          {testing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Wifi className="w-4 h-4 mr-2" />}
          Test Login
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// IMS Bot credentials editor (restarts headless browser on save)
// ─────────────────────────────────────────────────────────────
function ImsEditor({ onChanged }: { onChanged: () => void }) {
  const { toast } = useToast();
  const { data: creds, refetch } = useQuery({
    queryKey: ["ims-credentials"],
    queryFn: () => api.admin.imsCredentials(),
  });
  const [form, setForm] = useState<CredsForm>({ base_url: "", username: "", password: "", enabled: false });
  const [showPwd, setShowPwd] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (creds) setForm({
      base_url: creds.base_url || "",
      username: creds.username || "",
      password: "",
      enabled: creds.enabled,
    });
  }, [creds]);

  const save = async () => {
    setSaving(true);
    try {
      const body: { username?: string; password?: string; base_url?: string; enabled?: boolean } = {
        base_url: form.base_url,
        username: form.username,
        enabled: form.enabled,
      };
      if (form.password) body.password = form.password;
      await api.admin.imsCredentialsSave(body);
      toast({ title: "Saved", description: "IMS credentials updated. Restarting bot..." });
      setForm((f) => ({ ...f, password: "" }));
      await refetch();
      onChanged();
    } catch (e) {
      toast({ title: "Save failed", description: (e as Error).message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <div className="border-t border-white/[0.06] pt-4 space-y-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <KeyRound className="w-4 h-4 text-neon-cyan" />
        IMS Bot Credentials (imssms.org)
      </div>

      {creds && (
        <div className="text-xs text-muted-foreground bg-white/[0.02] rounded p-2 font-mono">
          Source — username: <span className="text-foreground/80">{creds.source.username}</span>
          {" · "}password: <span className="text-foreground/80">{creds.source.password}</span>
          {creds.has_password && <> · current: <span className="text-foreground/80">{creds.password_masked}</span></>}
        </div>
      )}

      <div className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
        <div>
          <div className="text-sm font-medium text-foreground">Enable IMS Bot</div>
          <div className="text-xs text-muted-foreground">Headless browser scraper on the VPS</div>
        </div>
        <Switch
          checked={!!form.enabled}
          onCheckedChange={(v) => setForm({ ...form, enabled: v })}
        />
      </div>

      <FormGrid form={form} setForm={setForm} showPwd={showPwd} setShowPwd={setShowPwd} hasPassword={!!creds?.has_password} />

      <div className="flex flex-wrap gap-2 pt-2">
        <SaveBtn onClick={save} loading={saving} disabled={saving} />
      </div>

      <p className="text-xs text-muted-foreground">
        Saving will hot-restart the headless browser so new credentials take effect immediately.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Shared bits
// ─────────────────────────────────────────────────────────────
function FormGrid({
  form, setForm, showPwd, setShowPwd, hasPassword,
}: {
  form: CredsForm;
  setForm: (f: CredsForm) => void;
  showPwd: boolean;
  setShowPwd: (b: boolean) => void;
  hasPassword: boolean;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="space-y-2">
        <Label className="text-xs">Base URL</Label>
        <Input
          value={form.base_url}
          onChange={(e) => setForm({ ...form, base_url: e.target.value })}
          placeholder="https://..."
          className="bg-white/[0.04] border-white/[0.1] h-10"
        />
      </div>
      <div className="space-y-2">
        <Label className="text-xs">Username</Label>
        <Input
          value={form.username}
          onChange={(e) => setForm({ ...form, username: e.target.value })}
          placeholder="account username"
          className="bg-white/[0.04] border-white/[0.1] h-10"
        />
      </div>
      <div className="space-y-2 md:col-span-2">
        <Label className="text-xs">
          Password {hasPassword && <span className="text-muted-foreground">(leave blank to keep current)</span>}
        </Label>
        <div className="relative">
          <Input
            type={showPwd ? "text" : "password"}
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            placeholder={hasPassword ? "••••••••" : "Enter password"}
            className="bg-white/[0.04] border-white/[0.1] h-10 pr-10"
          />
          <button
            type="button"
            onClick={() => setShowPwd(!showPwd)}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-muted-foreground hover:text-foreground"
          >
            {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}

function SaveBtn({ onClick, loading, disabled }: { onClick: () => void; loading: boolean; disabled?: boolean }) {
  return (
    <Button
      onClick={onClick}
      disabled={disabled}
      className="bg-gradient-to-r from-primary to-neon-magenta text-primary-foreground font-semibold hover:opacity-90 border-0"
    >
      {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
      Save
    </Button>
  );
}

export default AdminProviders;

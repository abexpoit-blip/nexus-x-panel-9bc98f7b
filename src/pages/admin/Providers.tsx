import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GlassCard } from "@/components/GlassCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Settings, CheckCircle, XCircle, Wifi, Server, Wallet, AlertTriangle,
  Eye, EyeOff, Save, Loader2, KeyRound,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { GradientMesh, PageHeader } from "@/components/premium";
import { api } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

const AdminProviders = () => {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: liveStatus } = useQuery({
    queryKey: ["provider-status"],
    queryFn: () => api.admin.providerStatus(),
    refetchInterval: 15000,
  });

  // AccHub credentials editor
  const [editing, setEditing] = useState<string | null>(null);
  const { data: acchubCreds, refetch: refetchAcc } = useQuery({
    queryKey: ["acchub-credentials"],
    queryFn: () => api.admin.acchubCredentials(),
    enabled: editing === "acchub",
  });

  const [accForm, setAccForm] = useState({ base_url: "", username: "", password: "" });
  const [showPwd, setShowPwd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (acchubCreds && editing === "acchub") {
      setAccForm({
        base_url: acchubCreds.base_url || "",
        username: acchubCreds.username || "",
        password: "",
      });
    }
  }, [acchubCreds, editing]);

  const saveAcchub = async () => {
    setSaving(true);
    try {
      const body: any = {
        base_url: accForm.base_url,
        username: accForm.username,
      };
      if (accForm.password) body.password = accForm.password;
      await api.admin.acchubCredentialsSave(body);
      toast({ title: "Saved", description: "AccHub credentials updated. Testing login..." });
      setAccForm((f) => ({ ...f, password: "" }));
      await refetchAcc();
      qc.invalidateQueries({ queryKey: ["provider-status"] });
      // Auto-test after save
      await testAcchub(false);
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message || String(e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const testAcchub = async (showSuccess = true) => {
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
      qc.invalidateQueries({ queryKey: ["provider-status"] });
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (showSuccess) toast({ title: "Test failed", description: msg, variant: "destructive" });
    } finally {
      setTesting(false);
    }
  };

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
        {providers.map((p) => {
          const isAcchub = p.id === "acchub";
          const isEditing = editing === p.id;
          const hasError = !!p.lastError;
          const isLive = p.configured && !hasError;

          return (
            <GlassCard key={p.id} className="!p-5">
              {/* Header row */}
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
                  {isAcchub && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setEditing(isEditing ? null : p.id)}
                      className="border-white/[0.1] hover:bg-white/[0.06]"
                    >
                      <Settings className="w-3.5 h-3.5 mr-1.5" />
                      {isEditing ? "Close" : "Edit"}
                    </Button>
                  )}
                </div>
              </div>

              {/* Error banner */}
              {hasError && (
                <div className="flex items-start gap-2 mb-3 p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-sm text-destructive">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="break-all font-mono text-xs">{p.lastError}</div>
                </div>
              )}

              {/* AccHub credentials editor */}
              {isAcchub && isEditing && (
                <div className="border-t border-white/[0.06] pt-4 space-y-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <KeyRound className="w-4 h-4 text-neon-cyan" />
                    AccHub Login Credentials
                  </div>

                  {acchubCreds && (
                    <div className="text-xs text-muted-foreground bg-white/[0.02] rounded p-2 font-mono">
                      Source — username: <span className="text-foreground/80">{acchubCreds.source.username}</span>
                      {" · "}password: <span className="text-foreground/80">{acchubCreds.source.password}</span>
                      {acchubCreds.has_password && <> · current: <span className="text-foreground/80">{acchubCreds.password_masked}</span></>}
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="text-xs">Base URL</Label>
                      <Input
                        value={accForm.base_url}
                        onChange={(e) => setAccForm({ ...accForm, base_url: e.target.value })}
                        placeholder="https://sms.acchub.io"
                        className="bg-white/[0.04] border-white/[0.1] h-10"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs">Username</Label>
                      <Input
                        value={accForm.username}
                        onChange={(e) => setAccForm({ ...accForm, username: e.target.value })}
                        placeholder="ShovonYE"
                        className="bg-white/[0.04] border-white/[0.1] h-10"
                      />
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <Label className="text-xs">
                        Password {acchubCreds?.has_password && <span className="text-muted-foreground">(leave blank to keep current)</span>}
                      </Label>
                      <div className="relative">
                        <Input
                          type={showPwd ? "text" : "password"}
                          value={accForm.password}
                          onChange={(e) => setAccForm({ ...accForm, password: e.target.value })}
                          placeholder={acchubCreds?.has_password ? "••••••••" : "Enter AccHub password"}
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

                  <div className="flex flex-wrap gap-2 pt-2">
                    <Button
                      onClick={saveAcchub}
                      disabled={saving || (!accForm.username && !accForm.password && !accForm.base_url)}
                      className="bg-gradient-to-r from-primary to-neon-magenta text-primary-foreground font-semibold hover:opacity-90 border-0"
                    >
                      {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                      Save & Test
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => testAcchub(true)}
                      disabled={testing}
                      className="border-white/[0.1] hover:bg-white/[0.06]"
                    >
                      {testing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Wifi className="w-4 h-4 mr-2" />}
                      Test Login
                    </Button>
                  </div>
                </div>
              )}
            </GlassCard>
          );
        })}
      </div>
    </div>
  );
};

export default AdminProviders;

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { GlassCard } from "@/components/GlassCard";
import { DataTable } from "@/components/DataTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatCard } from "@/components/StatCard";
import {
  Shield, UserX, UserCheck, AlertTriangle, Eye, UserPlus, Power,
  ScrollText, Monitor, LogOut, Smartphone, Globe, Search, Wrench, ShieldAlert,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { GradientMesh, PageHeader, PremiumKpiCard } from "@/components/premium";
import { api } from "@/lib/api";

const actionColor = (action: string) => {
  if (/login/i.test(action)) return "text-neon-cyan";
  if (/approve/i.test(action)) return "text-neon-green";
  if (/reject|delete|ban/i.test(action)) return "text-destructive";
  if (/topup|credit/i.test(action)) return "text-neon-amber";
  if (/withdraw/i.test(action)) return "text-neon-magenta";
  return "text-foreground";
};

const parseUA = (ua: string) => {
  const browser = /Chrome/i.test(ua) ? "Chrome" : /Firefox/i.test(ua) ? "Firefox" :
    /Safari/i.test(ua) ? "Safari" : /Edge/i.test(ua) ? "Edge" : "Unknown";
  const device = /Mobile|Android|iPhone/i.test(ua) ? "Mobile" : "Desktop";
  return { browser, device };
};

const AdminSecurity = () => {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"audit" | "sessions" | "impersonation" | "settings" | "maintenance">("audit");
  const [auditSearch, setAuditSearch] = useState("");
  const { signupEnabled, setSignupEnabled, maintenanceMode, maintenanceMessage, setMaintenanceMode } = useAuth();
  const [draftMsg, setDraftMsg] = useState(maintenanceMessage);

  const { data: auditData, isLoading: auditLoading } = useQuery({
    queryKey: ["audit-logs"], queryFn: () => api.audit.list({ limit: 200 }), refetchInterval: 30000,
  });
  const { data: sessData, isLoading: sessLoading } = useQuery({
    queryKey: ["sessions-all"], queryFn: () => api.sessions.all(), refetchInterval: 30000,
  });
  const { data: impData, isLoading: impLoading } = useQuery({
    queryKey: ["impersonations"], queryFn: () => api.admin.impersonations(), refetchInterval: 30000,
  });

  const revoke = useMutation({
    mutationFn: (id: number) => api.sessions.revoke(id),
    onSuccess: () => {
      toast.success("Session revoked — user will be logged out");
      qc.invalidateQueries({ queryKey: ["sessions-all"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const toggleSignup = () => {
    setSignupEnabled(!signupEnabled);
    toast.success(signupEnabled ? "Registration disabled" : "Registration enabled");
  };

  const logs = (auditData?.logs || []).filter((l) =>
    !auditSearch || `${l.action} ${l.username || ""} ${l.target_type || ""}`.toLowerCase().includes(auditSearch.toLowerCase())
  );
  const sessions = sessData?.sessions || [];

  const impersonations = impData?.impersonations || [];
  const tabs = [
    { key: "audit" as const, label: "Audit Log", icon: ScrollText, count: logs.length },
    { key: "sessions" as const, label: "Active Sessions", icon: Monitor, count: sessions.length },
    { key: "impersonation" as const, label: "Impersonation", icon: ShieldAlert, count: impersonations.length },
    { key: "settings" as const, label: "Registration", icon: UserPlus },
    { key: "maintenance" as const, label: "Maintenance", icon: Wrench },
  ];

  return (
    <div className="relative space-y-6">
      <GradientMesh variant="default" />
      <PageHeader
        eyebrow="Access Control"
        title="Security Center"
        description="Audit trail, active sessions, and access controls"
        icon={<Shield className="w-5 h-5 text-neon-magenta" />}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <PremiumKpiCard label="Audit Events" value={auditData?.logs?.length || 0} icon={ScrollText} tone="cyan" />
        <PremiumKpiCard label="Active Sessions" value={sessions.length} icon={Monitor} tone="green" />
        <PremiumKpiCard label="Unique Online" value={new Set(sessions.map((s) => s.user_id)).size} icon={UserCheck} tone="magenta" />
        <PremiumKpiCard label="Mobile Devices" value={sessions.filter((s) => /Mobile|Android|iPhone/i.test(s.user_agent)).length} icon={Smartphone} tone="amber" />
      </div>

      <div className="flex gap-1 p-1 glass rounded-xl w-fit overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap",
              tab === t.key
                ? "bg-primary/10 text-primary neon-border-cyan border"
                : "text-muted-foreground hover:text-foreground hover:bg-white/[0.04]"
            )}
          >
            <t.icon className="w-4 h-4" />
            {t.label}
            {typeof t.count === "number" && (
              <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] bg-white/[0.08]">{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {tab === "audit" && (
        <>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={auditSearch}
              onChange={(e) => setAuditSearch(e.target.value)}
              placeholder="Search by action, user, target…"
              className="pl-10 bg-white/[0.04] border-white/[0.1] h-11"
            />
          </div>
          <DataTable
            columns={[
              { key: "created_at", header: "Time", render: (r) => new Date(r.created_at * 1000).toLocaleString() },
              {
                key: "action", header: "Action",
                render: (r) => <span className={cn("font-mono text-xs font-semibold uppercase", actionColor(r.action))}>{r.action}</span>,
              },
              { key: "username", header: "By", render: (r) => <span className="font-semibold">{r.username || (r.user_id ? `#${r.user_id}` : "system")}</span> },
              { key: "target_type", header: "Target", render: (r) => (
                <span className="text-xs text-muted-foreground">
                  {r.target_type ? `${r.target_type}${r.target_id ? `#${r.target_id}` : ""}` : "—"}
                </span>
              )},
              { key: "ip", header: "IP", render: (r) => <span className="font-mono text-xs">{r.ip || "—"}</span> },
              { key: "meta", header: "Details", render: (r) => (
                <span className="text-xs text-muted-foreground line-clamp-1 max-w-xs">{r.meta || "—"}</span>
              )},
            ]}
            data={logs}
          />
          {auditLoading && <p className="text-center text-muted-foreground text-sm py-4">Loading audit trail…</p>}
          {!auditLoading && logs.length === 0 && (
            <GlassCard className="text-center py-8">
              <ScrollText className="w-10 h-10 text-muted-foreground mx-auto opacity-30" />
              <p className="text-sm text-muted-foreground mt-3">No audit events yet — actions will be recorded here</p>
            </GlassCard>
          )}
        </>
      )}

      {tab === "sessions" && (
        <>
          <DataTable
            columns={[
              { key: "username", header: "User", render: (r) => <span className="font-semibold">{r.username || `#${r.user_id}`}</span> },
              {
                key: "device", header: "Device",
                render: (r) => {
                  const { browser, device } = parseUA(r.user_agent);
                  return (
                    <div className="flex items-center gap-2">
                      {device === "Mobile" ? <Smartphone className="w-4 h-4 text-neon-cyan" /> : <Monitor className="w-4 h-4 text-neon-cyan" />}
                      <span className="text-sm">{browser} · {device}</span>
                    </div>
                  );
                },
              },
              { key: "ip", header: "IP", render: (r) => (
                <div className="flex items-center gap-1.5 font-mono text-xs">
                  <Globe className="w-3 h-3 text-muted-foreground" />
                  {r.ip}
                </div>
              )},
              { key: "created_at", header: "Started", render: (r) => new Date(r.created_at * 1000).toLocaleString() },
              { key: "last_seen_at", header: "Last Seen", render: (r) => {
                const mins = Math.floor((Date.now() / 1000 - r.last_seen_at) / 60);
                const isActive = mins < 5;
                return (
                  <span className={cn("text-xs", isActive ? "text-neon-green" : "text-muted-foreground")}>
                    {isActive ? "● active now" : mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h ago`}
                  </span>
                );
              }},
              {
                key: "actions", header: "",
                render: (r) => (
                  <Button
                    size="sm" variant="ghost"
                    onClick={() => {
                      if (window.confirm(`Revoke session for ${r.username || "user"}?`)) revoke.mutate(r.id);
                    }}
                    className="bg-destructive/15 text-destructive hover:bg-destructive/25 h-8"
                  >
                    <LogOut className="w-3.5 h-3.5 mr-1" /> Revoke
                  </Button>
                ),
              },
            ]}
            data={sessions}
          />
          {sessLoading && <p className="text-center text-muted-foreground text-sm py-4">Loading sessions…</p>}
          {!sessLoading && sessions.length === 0 && (
            <GlassCard className="text-center py-8">
              <Monitor className="w-10 h-10 text-muted-foreground mx-auto opacity-30" />
              <p className="text-sm text-muted-foreground mt-3">No active sessions</p>
            </GlassCard>
          )}
        </>
      )}

      {tab === "impersonation" && (
        <>
          <GlassCard className="p-4 border-neon-amber/20 bg-neon-amber/[0.03]">
            <div className="flex items-start gap-3">
              <ShieldAlert className="w-5 h-5 text-neon-amber shrink-0 mt-0.5" />
              <div className="text-sm text-muted-foreground">
                Every time an admin uses <span className="text-neon-amber font-semibold">"Login as"</span> on an agent, it's recorded here for transparency. The agent also receives an inbox notification.
              </div>
            </div>
          </GlassCard>
          <DataTable
            columns={[
              { key: "created_at", header: "Time", render: (r: any) => new Date(r.created_at * 1000).toLocaleString() },
              {
                key: "action", header: "Event",
                render: (r: any) => (
                  <span className={cn(
                    "px-2 py-0.5 rounded text-[10px] font-mono font-semibold uppercase",
                    r.action === "impersonation_start"
                      ? "bg-neon-amber/15 text-neon-amber"
                      : "bg-neon-green/15 text-neon-green"
                  )}>
                    {r.action === "impersonation_start" ? "🔓 Started" : "🔒 Ended"}
                  </span>
                ),
              },
              { key: "admin_username", header: "Admin", render: (r: any) => (
                <span className="font-semibold text-neon-cyan">{r.admin_username || `#${r.admin_id || "?"}`}</span>
              )},
              { key: "agent_username", header: "→ Agent", render: (r: any) => (
                <span className="font-semibold">{r.agent_username || `#${r.agent_id || "?"}`}</span>
              )},
              { key: "ip", header: "IP", render: (r: any) => <span className="font-mono text-xs">{r.ip || "—"}</span> },
            ]}
            data={impersonations}
          />
          {impLoading && <p className="text-center text-muted-foreground text-sm py-4">Loading…</p>}
          {!impLoading && impersonations.length === 0 && (
            <GlassCard className="text-center py-8">
              <ShieldAlert className="w-10 h-10 text-muted-foreground mx-auto opacity-30" />
              <p className="text-sm text-muted-foreground mt-3">No impersonation events yet</p>
            </GlassCard>
          )}
        </>
      )}

      {tab === "settings" && (
        <GlassCard glow={signupEnabled ? "cyan" : undefined}>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className={cn(
                "w-14 h-14 rounded-2xl flex items-center justify-center",
                signupEnabled ? "bg-neon-green/10" : "bg-destructive/10"
              )}>
                <Power className={cn("w-7 h-7", signupEnabled ? "text-neon-green" : "text-destructive")} />
              </div>
              <div>
                <h3 className="font-display font-bold text-foreground text-lg">Agent Registration</h3>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {signupEnabled
                    ? "Registration is OPEN — new agents can sign up"
                    : "Registration is CLOSED — no new signups allowed"}
                </p>
              </div>
            </div>
            <Button
              onClick={toggleSignup}
              className={cn(
                "h-11 font-semibold border-0 px-6",
                signupEnabled
                  ? "bg-destructive/20 text-destructive hover:bg-destructive/30"
                  : "bg-gradient-to-r from-primary to-neon-green text-primary-foreground hover:opacity-90"
              )}
            >
              {signupEnabled
                ? <><UserX className="w-4 h-4 mr-2" /> Disable Registration</>
                : <><UserCheck className="w-4 h-4 mr-2" /> Enable Registration</>}
            </Button>
          </div>
          <div className="mt-6 pt-4 border-t border-white/[0.06]">
            <div className="flex items-center gap-3">
              <div className={cn("w-3 h-3 rounded-full", signupEnabled ? "bg-neon-green animate-pulse" : "bg-destructive")} />
              <span className="text-sm text-muted-foreground">
                Status: <span className={cn("font-semibold", signupEnabled ? "text-neon-green" : "text-destructive")}>
                  {signupEnabled ? "ACTIVE" : "INACTIVE"}
                </span>
              </span>
            </div>
          </div>
        </GlassCard>
      )}
      {tab === "maintenance" && (
        <GlassCard className={maintenanceMode ? "border-neon-amber/40 bg-neon-amber/[0.04]" : ""}>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className={cn(
                "w-14 h-14 rounded-2xl flex items-center justify-center",
                maintenanceMode ? "bg-neon-amber/15" : "bg-neon-green/10"
              )}>
                <Wrench className={cn("w-7 h-7", maintenanceMode ? "text-neon-amber" : "text-neon-green")} />
              </div>
              <div>
                <h3 className="font-display font-bold text-foreground text-lg">Maintenance Mode</h3>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {maintenanceMode
                    ? "Agents CANNOT request numbers right now"
                    : "System OPEN — agents can request numbers normally"}
                </p>
              </div>
            </div>
            <Button
              onClick={() => {
                setMaintenanceMode(!maintenanceMode, draftMsg);
                toast.success(maintenanceMode ? "Maintenance disabled — agents can request numbers" : "Maintenance enabled — agents are blocked");
              }}
              className={cn(
                "h-11 font-semibold border-0 px-6",
                maintenanceMode
                  ? "bg-gradient-to-r from-primary to-neon-green text-primary-foreground hover:opacity-90"
                  : "bg-neon-amber/20 text-neon-amber hover:bg-neon-amber/30"
              )}
            >
              {maintenanceMode
                ? <><Power className="w-4 h-4 mr-2" /> Disable Maintenance</>
                : <><Wrench className="w-4 h-4 mr-2" /> Enable Maintenance</>}
            </Button>
          </div>

          <div className="mt-6 pt-4 border-t border-white/[0.06] space-y-3">
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Banner message shown to agents</label>
            <Textarea
              value={draftMsg}
              onChange={(e) => setDraftMsg(e.target.value)}
              placeholder="System is under maintenance. Please try again later."
              rows={3}
              className="bg-white/[0.04] border-white/[0.1] resize-none"
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setMaintenanceMode(maintenanceMode, draftMsg);
                  toast.success("Message saved");
                }}
                className="glass border-white/[0.1] hover:bg-white/[0.06]"
              >
                Save message
              </Button>
            </div>
            <div className="flex items-center gap-3 pt-2">
              <div className={cn("w-3 h-3 rounded-full", maintenanceMode ? "bg-neon-amber animate-pulse" : "bg-neon-green")} />
              <span className="text-sm text-muted-foreground">
                Status: <span className={cn("font-semibold", maintenanceMode ? "text-neon-amber" : "text-neon-green")}>
                  {maintenanceMode ? "MAINTENANCE" : "OPERATIONAL"}
                </span>
              </span>
            </div>
          </div>
        </GlassCard>
      )}
    </div>
  );
};

export default AdminSecurity;

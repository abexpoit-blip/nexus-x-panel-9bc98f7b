import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { GradientMesh, PageHeader } from "@/components/premium";
import { Settings, Clock, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const fmtH = (h: number) => (h >= 24 ? `${h / 24}d` : `${h}h`);

const OtpExpirySetting = () => {
  const [saving, setSaving] = useState(false);
  const { data, refetch, isLoading } = useQuery({
    queryKey: ["otp-expiry"],
    queryFn: () => api.admin.otpExpiry(),
  });
  const currentMin = data?.expiry_min ?? 10;
  const opts = data?.options_min ?? [5, 8, 10, 15, 20, 30];

  const save = async (m: number) => {
    if (m === currentMin) return;
    setSaving(true);
    try {
      await api.admin.otpExpirySave(m);
      toast.success(`OTP expiry set to ${m} min — applies to all providers`);
      await refetch();
    } catch (e) { toast.error("Failed: " + (e as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <div className="glass-card border border-white/[0.06] rounded-xl p-5 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Clock className="w-4 h-4 text-neon-amber" /> OTP Expiry Window
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            How long an allocated number stays "active" before auto-expiring. Affects every provider (IMS, MSI, AccHub).
            {data && (
              <span className="ml-2 font-mono">
                Current: <span className="text-neon-amber font-semibold">{currentMin} min</span>
                <span className="text-muted-foreground/60"> ({data.source})</span>
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {opts.map(v => (
            <button key={v} onClick={() => save(v)} disabled={saving || isLoading}
              className={cn(
                "px-4 py-2 rounded-md text-xs font-semibold border transition disabled:opacity-50",
                v === currentMin
                  ? "bg-neon-amber/15 border-neon-amber/40 text-neon-amber"
                  : "bg-white/[0.04] border-white/[0.08] text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
              )}>
              {v}m
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

const RecentOtpWindowSetting = () => {
  const [saving, setSaving] = useState(false);
  const { data, refetch, isLoading } = useQuery({
    queryKey: ["recent-otp-window"],
    queryFn: () => api.admin.recentOtpWindow(),
  });
  const current = data?.hours ?? 24;
  const opts = data?.options_hours ?? [1, 6, 12, 24, 48, 72, 168];

  const save = async (h: number) => {
    if (h === current) return;
    setSaving(true);
    try {
      await api.admin.recentOtpWindowSave(h);
      toast.success(`Recent OTP window set to ${fmtH(h)}`);
      await refetch();
    } catch (e) { toast.error("Failed: " + (e as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <div className="glass-card border border-white/[0.06] rounded-xl p-5 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Zap className="w-4 h-4 text-neon-magenta" /> Recent OTP Visibility
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            How long delivered OTPs stay on agents' live list before moving to permanent OTP History.
            Stats stay forever regardless. Applies to all providers.
            {data && (
              <span className="ml-2 font-mono">
                Current: <span className="text-neon-magenta font-semibold">{fmtH(current)}</span>
                <span className="text-muted-foreground/60"> ({data.source})</span>
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {opts.map(v => (
            <button key={v} onClick={() => save(v)} disabled={saving || isLoading}
              className={cn(
                "px-4 py-2 rounded-md text-xs font-semibold border transition disabled:opacity-50",
                v === current
                  ? "bg-neon-magenta/15 border-neon-magenta/40 text-neon-magenta"
                  : "bg-white/[0.04] border-white/[0.08] text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
              )}>
              {fmtH(v)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

const AdminProviderSettings = () => {
  return (
    <div className="relative space-y-6">
      <GradientMesh variant="default" />
      <PageHeader
        eyebrow="Workers"
        title="Provider Settings"
        description="Global settings shared across IMS, MSI, AccHub and any future provider"
        icon={<Settings className="w-5 h-5 text-neon-cyan" />}
      />
      <OtpExpirySetting />
      <RecentOtpWindowSetting />
    </div>
  );
};

export default AdminProviderSettings;

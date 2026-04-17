import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GlassCard } from "@/components/GlassCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Settings, Trash2, CheckCircle, XCircle, Wifi, Server, Wallet, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { GradientMesh, PageHeader } from "@/components/premium";
import { api } from "@/lib/api";

interface Provider {
  id: string;
  name: string;
  apiUrl: string;
  apiKey: string;
  status: "active" | "inactive";
  numbersCount: number;
}

const MOCK_PROVIDERS: Provider[] = [
  { id: "1", name: "MSI SMS", apiUrl: "https://api.msi-sms.com/v1", apiKey: "msi_****_4f2a", status: "active", numbersCount: 12400 },
  { id: "2", name: "IMS SMS", apiUrl: "https://api.ims-sms.com/v2", apiKey: "ims_****_8b3c", status: "active", numbersCount: 8200 },
  { id: "3", name: "AccHub", apiUrl: "https://api.acchub.io/v1", apiKey: "ach_****_d1e5", status: "active", numbersCount: 15600 },
  { id: "4", name: "Seven1Tel", apiUrl: "https://api.seven1tel.com", apiKey: "s7t_****_9a7f", status: "inactive", numbersCount: 6800 },
];

const AdminProviders = () => {
  const [providers] = useState(MOCK_PROVIDERS);
  const [showAdd, setShowAdd] = useState(false);
  const { data: liveStatus } = useQuery({
    queryKey: ["provider-status"],
    queryFn: () => api.admin.providerStatus(),
    refetchInterval: 15000,
  });

  return (
    <div className="relative space-y-6">
      <GradientMesh variant="default" />
      <PageHeader
        eyebrow="Infrastructure"
        title="SMS Providers"
        description="Manage upstream IPRN/SMS API providers"
        icon={<Server className="w-5 h-5 text-neon-cyan" />}
        actions={
          <Button
            onClick={() => setShowAdd(!showAdd)}
            className="bg-gradient-to-r from-primary to-neon-magenta text-primary-foreground font-semibold hover:opacity-90 border-0"
          >
            <Plus className="w-4 h-4 mr-2" />
            Add Provider
          </Button>
        }
      />

      {showAdd && (
        <GlassCard glow="cyan">
          <h3 className="font-display font-semibold text-foreground mb-4">New Provider</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm text-muted-foreground">Provider Name</label>
              <Input className="bg-white/[0.04] border-white/[0.1] h-11" placeholder="e.g. MSI SMS" />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-muted-foreground">API URL</label>
              <Input className="bg-white/[0.04] border-white/[0.1] h-11" placeholder="https://api.provider.com/v1" />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-muted-foreground">API Key / Token</label>
              <Input className="bg-white/[0.04] border-white/[0.1] h-11" placeholder="Enter API key" type="password" />
            </div>
            <div className="flex items-end gap-2">
              <Button className="h-11 glass hover:bg-white/[0.08]"><Wifi className="w-4 h-4 mr-2" />Test Connection</Button>
              <Button className="h-11 bg-primary text-primary-foreground">Save</Button>
            </div>
          </div>
        </GlassCard>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {providers.map((p) => (
          <GlassCard key={p.id} className="!p-5">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h4 className="font-display font-semibold text-foreground">{p.name}</h4>
                <p className="text-xs text-muted-foreground font-mono mt-1">{p.apiUrl}</p>
              </div>
              <span className={cn(
                "px-2.5 py-1 rounded-full text-[11px] font-semibold flex items-center gap-1",
                p.status === "active" ? "bg-neon-green/10 text-neon-green" : "bg-neon-red/10 text-neon-red"
              )}>
                {p.status === "active" ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                {p.status}
              </span>
            </div>
            <div className="flex items-center justify-between pt-3 border-t border-white/[0.06]">
              <div className="text-sm text-muted-foreground">
                <span className="text-foreground font-semibold">{p.numbersCount.toLocaleString()}</span> numbers
              </div>
              <div className="flex gap-2">
                <button className="p-2 rounded-lg hover:bg-white/[0.06] text-muted-foreground hover:text-primary transition-colors">
                  <Settings className="w-4 h-4" />
                </button>
                <button className="p-2 rounded-lg hover:bg-neon-red/10 text-muted-foreground hover:text-neon-red transition-colors">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          </GlassCard>
        ))}
      </div>
    </div>
  );
};

export default AdminProviders;

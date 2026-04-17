import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { AnimatedOutlet } from "@/components/AnimatedOutlet";
import { useAuth, type UserRole } from "@/contexts/AuthContext";
import { AppSidebar } from "./Sidebar";
import { NotificationBell } from "@/components/NotificationBell";
import { CommandPalette } from "@/components/CommandPalette";
import { Menu, Wallet, Search, Wrench, ShieldAlert, LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface AppLayoutProps {
  requiredRole: UserRole;
}

export const AppLayout = ({ requiredRole }: AppLayoutProps) => {
  const { user, isAuthenticated, maintenanceMode, maintenanceMessage, impersonator, exitImpersonation } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const navigate = useNavigate();

  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (user?.role !== requiredRole) return <Navigate to={`/${user?.role}/dashboard`} replace />;

  const handleExit = async () => {
    await exitImpersonation();
    toast.success("Returned to admin account");
    navigate("/admin/agents");
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <CommandPalette />
      <AppSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {impersonator && (
          <div className="flex items-center justify-between gap-3 px-4 py-2 bg-neon-amber/15 border-b border-neon-amber/40 text-neon-amber text-xs sm:text-sm font-semibold">
            <div className="flex items-center gap-2 min-w-0">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span className="truncate">
                Viewing as <span className="font-mono">{user?.username}</span> — original admin: <span className="font-mono">{impersonator.username}</span>
              </span>
            </div>
            <button
              onClick={handleExit}
              className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-neon-amber text-background hover:opacity-90 shrink-0"
            >
              <LogOut className="w-3.5 h-3.5" /> Exit
            </button>
          </div>
        )}
        {/* Header */}
        <header className="h-14 flex items-center justify-between px-4 md:px-6 border-b border-white/[0.06] bg-background/80 backdrop-blur-md shrink-0">
          <button
            onClick={() => setSidebarOpen(true)}
            className="lg:hidden p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-white/[0.04]"
          >
            <Menu className="w-5 h-5" />
          </button>

          <div className="flex-1 flex items-center">
            <button
              onClick={() => {
                // Trigger command palette via synthetic Cmd+K event
                window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
              }}
              className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg glass text-sm text-muted-foreground hover:text-foreground hover:bg-white/[0.06] transition-colors w-72"
              aria-label="Open command palette"
            >
              <Search className="w-3.5 h-3.5" />
              <span>Search or jump to…</span>
              <kbd className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/[0.08] border border-white/[0.1]">⌘K</kbd>
            </button>
          </div>

          <div className="flex items-center gap-3">
            {maintenanceMode && (
              <div
                title={maintenanceMessage}
                className={cn(
                  "hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold",
                  "bg-neon-amber/15 text-neon-amber border border-neon-amber/30 animate-pulse"
                )}
              >
                <Wrench className="w-3.5 h-3.5" />
                <span className="uppercase tracking-wider">Maintenance</span>
              </div>
            )}
            {user?.role === "agent" && (
              <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 glass rounded-lg text-sm">
                <Wallet className="w-4 h-4 text-neon-green" />
                <span className="text-muted-foreground">Balance:</span>
                <span className="font-semibold text-foreground">৳{user.balance.toFixed(2)}</span>
              </div>
            )}
            <NotificationBell />
          </div>
        </header>

        {/* Mobile maintenance bar */}
        {maintenanceMode && (
          <div className="sm:hidden flex items-center gap-2 px-4 py-2 bg-neon-amber/15 text-neon-amber border-b border-neon-amber/30 text-xs font-semibold">
            <Wrench className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">Maintenance mode active</span>
          </div>
        )}

        {/* Content */}
        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          <AnimatedOutlet />
        </main>
      </div>
    </div>
  );
};

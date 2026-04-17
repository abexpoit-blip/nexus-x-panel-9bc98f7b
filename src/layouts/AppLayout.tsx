import { useState } from "react";
import { Navigate } from "react-router-dom";
import { AnimatedOutlet } from "@/components/AnimatedOutlet";
import { useAuth, type UserRole } from "@/contexts/AuthContext";
import { AppSidebar } from "./Sidebar";
import { NotificationBell } from "@/components/NotificationBell";
import { CommandPalette } from "@/components/CommandPalette";
import { Menu, Wallet, Search, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";

interface AppLayoutProps {
  requiredRole: UserRole;
}

export const AppLayout = ({ requiredRole }: AppLayoutProps) => {
  const { user, isAuthenticated, maintenanceMode, maintenanceMessage } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (user?.role !== requiredRole) return <Navigate to={`/${user?.role}/dashboard`} replace />;

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <CommandPalette />
      <AppSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
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

        {/* Content */}
        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          <AnimatedOutlet />
        </main>
      </div>
    </div>
  );
};

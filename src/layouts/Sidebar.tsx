import { NavLink, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";
import { NexusLogo, APP_VERSION } from "@/components/NexusLogo";
import { useAuth } from "@/contexts/AuthContext";
import { useNotifications } from "@/contexts/NotificationContext";
import { prefetchPage } from "@/lib/lazyPages";
import {
  LayoutDashboard, Hash, MessageSquare, List, BarChart3, Bell, Inbox,
  Users, Server, DollarSign, FileText, LogOut, X, Layers,
  Wallet, Shield, User, CreditCard, Trophy, Bot, ArrowDownToLine, History, Settings
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface NavItem {
  label: string;
  path: string;
  icon: LucideIcon;
}

const agentNav: NavItem[] = [
  { label: "Dashboard", path: "/agent/dashboard", icon: LayoutDashboard },
  { label: "Get Number", path: "/agent/get-number", icon: Hash },
  { label: "Console", path: "/agent/console", icon: MessageSquare },
  { label: "My Numbers", path: "/agent/my-numbers", icon: List },
  { label: "OTP History", path: "/agent/history", icon: History },
  { label: "Summary", path: "/agent/summary", icon: BarChart3 },
  { label: "Leaderboard", path: "/agent/leaderboard", icon: Trophy },
  { label: "Payments", path: "/agent/payments", icon: Wallet },
  { label: "Inbox", path: "/agent/inbox", icon: Inbox },
  { label: "Profile", path: "/agent/profile", icon: User },
];

const adminNav: NavItem[] = [
  { label: "Dashboard", path: "/admin/dashboard", icon: LayoutDashboard },
  { label: "Providers", path: "/admin/providers", icon: Server },
  { label: "Agents", path: "/admin/agents", icon: Users },
  { label: "Rate Card", path: "/admin/rates", icon: DollarSign },
  { label: "Allocation", path: "/admin/allocation", icon: Layers },
  { label: "Payments", path: "/admin/payments", icon: CreditCard },
  { label: "Withdrawals", path: "/admin/withdrawals", icon: ArrowDownToLine },
  { label: "Security", path: "/admin/security", icon: Shield },
  { label: "SMS CDR", path: "/admin/cdr", icon: FileText },
  { label: "IMS Bot", path: "/admin/ims-status", icon: Bot },
  { label: "MSI Bot", path: "/admin/msi-status", icon: Bot },
  { label: "NumPanel Bot", path: "/admin/numpanel-status", icon: Bot },
  { label: "XISORA Bot", path: "/admin/xisora-status", icon: Bot },
  { label: "TG Bot", path: "/admin/tg-bot", icon: Bot },
  // Provider Settings (OTP expiry / recent-OTP window) is now embedded inside
  // the IMS Bot page; route /admin/provider-settings still works for direct links.
  { label: "Notifications", path: "/admin/notifications", icon: Bell },
];

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

export const AppSidebar = ({ open, onClose }: SidebarProps) => {
  const { user, logout } = useAuth();
  const { announcements } = useNotifications();
  const location = useLocation();
  const nav = user?.role === "admin" ? adminNav : agentNav;
  const unreadAnnouncements = announcements.filter((a) => !a.read).length;

  return (
    <>
      {open && (
        <div className="fixed inset-0 bg-black/60 z-40 lg:hidden" onClick={onClose} />
      )}

      <aside
        className={cn(
          "fixed top-0 left-0 h-full w-64 z-50 flex flex-col transition-transform duration-300 ease-out",
          "bg-[hsl(240,12%,5%)] border-r border-white/[0.06]",
          "lg:translate-x-0 lg:static lg:z-auto",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex items-center justify-between px-5 h-16 border-b border-white/[0.06]">
          <NexusLogo size="sm" />
          <button onClick={onClose} className="lg:hidden p-1 text-muted-foreground hover:text-foreground">
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto scrollbar-none px-3 py-4 space-y-1">
          {nav.map((item) => {
            const active = location.pathname === item.path;
            return (
              <NavLink
                key={item.path}
                to={item.path}
                onClick={onClose}
                onMouseEnter={() => prefetchPage(item.path)}
                onFocus={() => prefetchPage(item.path)}
                onTouchStart={() => prefetchPage(item.path)}
                className={cn(
                  "group relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-300",
                  active
                    ? "text-primary gradient-border-glow bg-gradient-to-r from-primary/15 via-primary/5 to-transparent shadow-[0_0_20px_-5px_hsl(185_100%_50%/0.4)]"
                    : "text-muted-foreground hover:text-foreground hover:bg-white/[0.04] hover:translate-x-0.5"
                )}
              >
                <item.icon
                  className={cn(
                    "w-4.5 h-4.5 transition-transform duration-300 group-hover:scale-110",
                    active && "text-primary drop-shadow-[0_0_6px_hsl(185_100%_50%/0.8)]"
                  )}
                />
                <span className="flex-1">{item.label}</span>
                {item.path === "/agent/inbox" && unreadAnnouncements > 0 && (
                  <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-neon-magenta/20 text-neon-magenta min-w-[18px] text-center animate-pulse">
                    {unreadAnnouncements > 9 ? "9+" : unreadAnnouncements}
                  </span>
                )}
              </NavLink>
            );
          })}
        </nav>

        <div className="p-4 border-t border-white/[0.06]">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary/30 to-secondary/30 flex items-center justify-center text-xs font-bold text-foreground">
              {user?.username?.[0]?.toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground truncate">{user?.username}</p>
              <p className="text-xs text-muted-foreground capitalize">{user?.role}</p>
            </div>
          </div>
          <button
            onClick={logout}
            className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-neon-red hover:bg-neon-red/10 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
          <div className="mt-3 pt-3 border-t border-white/[0.06] text-center">
            <span className="text-[10px] font-mono text-muted-foreground/60">Nexus X {APP_VERSION}</span>
          </div>
        </div>
      </aside>
    </>
  );
};

import { AnimatePresence, motion } from "framer-motion";
import { Bell, BellOff, CheckCheck, Trash2, X, Inbox } from "lucide-react";
import { useNotifications } from "@/contexts/NotificationContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Notification as ApiNotification } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

function timeAgo(ts: number): string {
  const seconds = Math.floor(Date.now() / 1000 - ts);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const typeBorder: Record<string, string> = {
  info: "border-l-primary",
  success: "border-l-neon-green",
  warning: "border-l-neon-amber",
  error: "border-l-destructive",
  system: "border-l-neon-cyan",
};

const typeDot: Record<string, string> = {
  info: "bg-primary",
  success: "bg-neon-green",
  warning: "bg-neon-amber",
  error: "bg-destructive",
  system: "bg-neon-cyan",
};

const iconFor = (n: ApiNotification): string => {
  if (n.title.toLowerCase().includes("otp")) return "📩";
  if (/withdraw/i.test(n.title)) return "💰";
  if (/signup|approval|pending/i.test(n.title)) return "👤";
  if (n.type === "success") return "✅";
  if (n.type === "warning") return "⚠️";
  if (n.type === "error") return "❌";
  return "🔔";
};

export function NotificationPanel() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { panelOpen, closePanel, preferences, updatePreferences } = useNotifications();
  const { soundEnabled } = preferences;

  // Single source of truth: backend. Per-user filtering already applied server-side.
  const { data, isLoading } = useQuery({
    queryKey: ["nav-notifications", user?.id],
    queryFn: () => api.notifications.list(),
    enabled: !!user && panelOpen,
    refetchInterval: panelOpen ? 5000 : false,
  });

  const items = data?.notifications || [];
  const unreadCount = data?.unread ?? 0;

  const markRead = useMutation({
    mutationFn: (id: number) => api.notifications.markRead(id),
    onMutate: async (id) => {
      // Optimistic — flip is_read locally so the badge clears instantly
      await qc.cancelQueries({ queryKey: ["nav-notifications", user?.id] });
      const prev = qc.getQueryData<{ notifications: ApiNotification[]; unread: number }>([
        "nav-notifications", user?.id,
      ]);
      if (prev) {
        qc.setQueryData(["nav-notifications", user?.id], {
          notifications: prev.notifications.map((n) => (n.id === id ? { ...n, is_read: 1 } : n)),
          unread: Math.max(0, prev.unread - 1),
        });
      }
      return { prev };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(["nav-notifications", user?.id], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["nav-notifications", user?.id] }),
  });

  const markAll = useMutation({
    mutationFn: () => api.notifications.markAllRead(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["nav-notifications", user?.id] });
      toast.success("All notifications marked as read");
    },
  });

  const toggleSound = () => updatePreferences({ soundEnabled: !soundEnabled });

  return (
    <>
      <AnimatePresence>
        {panelOpen && (
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-sm"
            onClick={closePanel}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {panelOpen && (
          <motion.div
            key="panel"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 300 }}
            className="fixed top-0 right-0 z-[101] h-full w-full sm:w-[420px] flex flex-col bg-card border-l border-border shadow-2xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-primary/10">
                  <Bell className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <h2 className="font-display font-semibold text-foreground text-lg">Notifications</h2>
                  <p className="text-xs text-muted-foreground">
                    {unreadCount > 0 ? `${unreadCount} unread` : "All caught up"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={toggleSound}
                  className="p-2 rounded-lg hover:bg-white/[0.06] transition-colors text-muted-foreground hover:text-foreground"
                  title={soundEnabled ? "Mute sounds" : "Enable sounds"}
                >
                  {soundEnabled ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
                </button>
                {unreadCount > 0 && (
                  <button
                    onClick={() => markAll.mutate()}
                    disabled={markAll.isPending}
                    className="p-2 rounded-lg hover:bg-white/[0.06] transition-colors text-muted-foreground hover:text-foreground disabled:opacity-50"
                    title="Mark all read"
                  >
                    <CheckCheck className="w-4 h-4" />
                  </button>
                )}
                <button
                  onClick={() => markAll.mutate()}
                  disabled={markAll.isPending || items.length === 0}
                  className="p-2 rounded-lg hover:bg-white/[0.06] transition-colors text-muted-foreground hover:text-foreground disabled:opacity-30"
                  title="Clear (mark all read)"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
                <button
                  onClick={closePanel}
                  className="p-2 rounded-lg hover:bg-white/[0.06] transition-colors text-muted-foreground hover:text-foreground"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Notification list */}
            <div className="flex-1 overflow-y-auto scrollbar-none">
              {isLoading && items.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3 p-8">
                  <div className="p-4 rounded-2xl bg-white/[0.03]">
                    <Bell className="w-10 h-10 opacity-30 animate-pulse" />
                  </div>
                  <p className="text-sm">Loading…</p>
                </div>
              ) : items.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3 p-8">
                  <div className="p-4 rounded-2xl bg-white/[0.03]">
                    <Inbox className="w-10 h-10 opacity-30" />
                  </div>
                  <p className="text-sm">No notifications yet</p>
                  <p className="text-xs opacity-60 text-center max-w-[260px]">
                    OTP deliveries and admin notices will appear here
                  </p>
                </div>
              ) : (
                <div className="py-2">
                  <AnimatePresence initial={false}>
                    {items.map((n, i) => {
                      const isUnread = !n.is_read;
                      return (
                        <motion.div
                          key={n.id}
                          initial={{ opacity: 0, x: 30, height: 0 }}
                          animate={{ opacity: 1, x: 0, height: "auto" }}
                          exit={{ opacity: 0, x: 30, height: 0 }}
                          transition={{ duration: 0.25, delay: i < 5 ? i * 0.03 : 0 }}
                        >
                          <button
                            onClick={() => isUnread && markRead.mutate(n.id)}
                            className={cn(
                              "w-full text-left px-5 py-3.5 border-l-[3px] transition-all hover:bg-white/[0.04] group",
                              typeBorder[n.type] || typeBorder.info,
                              isUnread ? "bg-white/[0.02]" : "opacity-60 hover:opacity-100"
                            )}
                          >
                            <div className="flex items-start gap-3">
                              <span className="text-xl mt-0.5 shrink-0">{iconFor(n)}</span>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-2 min-w-0">
                                    {isUnread && (
                                      <span className={cn("w-2 h-2 rounded-full shrink-0", typeDot[n.type] || typeDot.info)} />
                                    )}
                                    <p className={cn(
                                      "text-sm truncate",
                                      isUnread ? "font-semibold text-foreground" : "text-muted-foreground"
                                    )}>
                                      {n.title}
                                    </p>
                                  </div>
                                  <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0">
                                    {timeAgo(n.created_at)}
                                  </span>
                                </div>
                                <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap line-clamp-3">{n.message}</p>
                              </div>
                            </div>
                          </button>
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </div>
              )}
            </div>

            {/* Footer */}
            {items.length > 0 && (
              <div className="px-5 py-3 border-t border-border text-center shrink-0">
                <p className="text-xs text-muted-foreground">
                  {items.length} notification{items.length !== 1 ? "s" : ""} • Live updates every 5s
                </p>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

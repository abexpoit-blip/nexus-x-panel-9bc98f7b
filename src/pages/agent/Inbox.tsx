import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { GlassCard } from "@/components/GlassCard";
import { Button } from "@/components/ui/button";
import { Inbox as InboxIcon, CheckCheck, Bell } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePagination } from "@/components/Pagination";

const typeColor: Record<string, string> = {
  info: "border-primary/40 bg-primary/5",
  success: "border-neon-green/40 bg-neon-green/5",
  warning: "border-neon-amber/40 bg-neon-amber/5",
  error: "border-destructive/40 bg-destructive/5",
};

const AgentInbox = () => {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.notifications.list(),
    refetchInterval: 20000,
  });

  const markRead = useMutation({
    mutationFn: (id: number) => api.notifications.markRead(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const markAll = useMutation({
    mutationFn: () => api.notifications.markAllRead(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  // Inbox shows admin notices/broadcasts only — OTP notifications live in Console.
  const items = (data?.notifications || []).filter(
    (n) => n.title !== "OTP received"
  );
  const unreadCount = items.filter((n) => !n.is_read).length;
  const { items: pagedItems, controls: pagedControls } = usePagination(items, 25);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-display font-bold text-foreground flex items-center gap-2">
            <InboxIcon className="w-7 h-7 text-primary" /> Inbox
            {unreadCount ? <span className="text-sm bg-neon-magenta/20 text-neon-magenta px-2 py-0.5 rounded-full">{unreadCount} new</span> : null}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Admin notices & broadcasts only — OTPs appear in Console</p>
        </div>
        <Button variant="outline" onClick={() => markAll.mutate()} disabled={!unreadCount}>
          <CheckCheck className="w-4 h-4 mr-2" /> Mark all read
        </Button>
      </div>

      <div className="space-y-3">
        {pagedItems.map((n) => (
          <GlassCard
            key={n.id}
            className={cn(
              "p-4 cursor-pointer border-l-2",
              typeColor[n.type] || typeColor.info,
              !n.is_read && "ring-1 ring-primary/20"
            )}
            onClick={() => !n.is_read && markRead.mutate(n.id)}
          >
            <div className="flex items-start gap-3">
              <Bell className={cn("w-4 h-4 mt-1 shrink-0", !n.is_read ? "text-primary" : "text-muted-foreground")} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-3">
                  <h4 className={cn("font-semibold", !n.is_read ? "text-foreground" : "text-muted-foreground")}>{n.title}</h4>
                  <span className="text-xs text-muted-foreground shrink-0">{new Date(n.created_at * 1000).toLocaleString()}</span>
                </div>
                <p className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap">{n.message}</p>
              </div>
            </div>
          </GlassCard>
        ))}
        {!items.length && <p className="text-center text-muted-foreground text-sm py-12">No notifications</p>}
        {pagedControls}
      </div>
    </div>
  );
};

export default AgentInbox;

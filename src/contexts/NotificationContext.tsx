import React, { useState, useCallback, useRef, useEffect } from "react";
import { toast } from "sonner";
import {
  NotificationContext,
  type Notification,
  type Announcement,
  type NotificationPreferences,
} from "./notification-context";

// Re-export so existing imports keep working
export { useNotifications } from "@/hooks/useNotifications";
export type {
  NotificationType,
  Notification,
  Announcement,
  NotificationPreferences,
  NotificationContextType,
} from "./notification-context";

const DEFAULT_PREFERENCES: NotificationPreferences = {
  soundEnabled: true,
  soundVolume: 50,
  toastsEnabled: true,
  enabledTypes: { info: true, success: true, warning: true, error: true, system: true },
};

function playNotificationSound(volume: number) {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.08);
    osc.type = "sine";

    const vol = (volume / 100) * 0.3;
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not available
  }
}

// Production: no fake/simulated notifications. Real notifications come from
// backend via NotificationBell polling. This context handles in-app
// announcements (admin broadcasts) and user notification preferences.
const INITIAL_NOTIFICATIONS: Notification[] = [];

const INITIAL_ANNOUNCEMENTS: Announcement[] = [];

// Bump this whenever stale demo/fake notifications need to be wiped from
// users' localStorage. Old keys are deleted on next app load.
const ANNOUNCEMENTS_VERSION = "v2-real-only";
const ANNOUNCEMENTS_KEY = `nexus_announcements_${ANNOUNCEMENTS_VERSION}`;

export const NotificationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [notifications, setNotifications] = useState<Notification[]>(INITIAL_NOTIFICATIONS);
  const [announcements, setAnnouncements] = useState<Announcement[]>(() => {
    // One-time cleanup: remove any old announcement caches from previous versions
    try { localStorage.removeItem("nexus_announcements"); } catch { /* ignore */ }
    const stored = localStorage.getItem(ANNOUNCEMENTS_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        return parsed.map((a: any) => ({ ...a, time: new Date(a.time) }));
      } catch { /* fallback */ }
    }
    return INITIAL_ANNOUNCEMENTS;
  });
  const [panelOpen, setPanelOpen] = useState(false);
  const [preferences, setPreferences] = useState<NotificationPreferences>(() => {
    const stored = localStorage.getItem("nexus_notif_prefs");
    return stored ? { ...DEFAULT_PREFERENCES, ...JSON.parse(stored) } : DEFAULT_PREFERENCES;
  });
  const [serverUnread, setServerUnread] = useState(0);
  const prefsRef = useRef(preferences);
  prefsRef.current = preferences;

  useEffect(() => {
    localStorage.setItem(ANNOUNCEMENTS_KEY, JSON.stringify(announcements));
  }, [announcements]);

  const unreadCount = notifications.filter((n) => !n.read).length;
  const unreadAnnouncements = announcements.filter((a) => !a.read).length;
  // Tab title uses real backend unread (set by NotificationBell) + in-app announcements
  const totalUnread = serverUnread + unreadAnnouncements;

  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) Nexus X` : "Nexus X";
    return () => { document.title = "Nexus X"; };
  }, [totalUnread]);

  const addNotification = useCallback((n: Omit<Notification, "id" | "time" | "read">) => {
    const prefs = prefsRef.current;
    if (!prefs.enabledTypes[n.type]) return;

    const newNotif: Notification = {
      ...n,
      id: crypto.randomUUID(),
      time: new Date(),
      read: false,
    };
    setNotifications((prev) => [newNotif, ...prev]);
    if (prefs.soundEnabled) playNotificationSound(prefs.soundVolume);

    if (prefs.toastsEnabled) {
      const toastMethod = n.type === "error" ? toast.error
        : n.type === "warning" ? toast.warning
        : n.type === "success" ? toast.success
        : toast.info;
      toastMethod(n.title, { description: n.message, duration: 4000 });
    }
  }, []);

  const sendAnnouncement = useCallback((n: Omit<Announcement, "id" | "time" | "read">) => {
    const newAnnouncement: Announcement = {
      ...n,
      id: crypto.randomUUID(),
      time: new Date(),
      read: false,
    };
    setAnnouncements((prev) => [newAnnouncement, ...prev]);
  }, []);

  // Production: no simulated events. Real notifications arrive via NotificationBell polling.
  const setUnreadFromServer = useCallback((n: number) => setServerUnread(n), []);

  const markAsRead = useCallback((id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    setAnnouncements((prev) => prev.map((a) => ({ ...a, read: true })));
  }, []);

  const markAnnouncementRead = useCallback((id: string) => {
    setAnnouncements((prev) => prev.map((a) => (a.id === id ? { ...a, read: true } : a)));
  }, []);

  const clearAll = useCallback(() => setNotifications([]), []);
  const togglePanel = useCallback(() => setPanelOpen((p) => !p), []);
  const closePanel = useCallback(() => setPanelOpen(false), []);

  const updatePreferences = useCallback((p: Partial<NotificationPreferences>) => {
    setPreferences((prev) => {
      const next = { ...prev, ...p };
      localStorage.setItem("nexus_notif_prefs", JSON.stringify(next));
      return next;
    });
  }, []);

  return (
    <NotificationContext.Provider value={{
      notifications, announcements, unreadCount, serverUnread, panelOpen, preferences,
      addNotification, sendAnnouncement, setUnreadFromServer,
      markAsRead, markAllRead, markAnnouncementRead,
      clearAll, togglePanel, closePanel, updatePreferences,
    }}>
      {children}
    </NotificationContext.Provider>
  );
};

// Plain TS file — context lives here so HMR of the provider component
// can't invalidate consumer subscriptions.
import { createContext } from "react";

export type NotificationType = "info" | "success" | "warning" | "error" | "system";

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  time: Date;
  read: boolean;
  icon?: string;
}

export interface Announcement {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  time: Date;
  read: boolean;
  icon?: string;
}

export interface NotificationPreferences {
  soundEnabled: boolean;
  soundVolume: number; // 0-100
  toastsEnabled: boolean;
  enabledTypes: Record<NotificationType, boolean>;
}

export interface NotificationContextType {
  notifications: Notification[];
  announcements: Announcement[];
  unreadCount: number;
  serverUnread: number;
  panelOpen: boolean;
  preferences: NotificationPreferences;
  addNotification: (n: Omit<Notification, "id" | "time" | "read">) => void;
  sendAnnouncement: (n: Omit<Announcement, "id" | "time" | "read">) => void;
  setUnreadFromServer: (n: number) => void;
  markAsRead: (id: string) => void;
  markAllRead: () => void;
  markAnnouncementRead: (id: string) => void;
  clearAll: () => void;
  togglePanel: () => void;
  closePanel: () => void;
  updatePreferences: (p: Partial<NotificationPreferences>) => void;
}

export const NotificationContext = createContext<NotificationContextType | null>(null);

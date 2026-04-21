import { lazy } from "react";

// Centralized lazy imports + prefetch map. Same chunk is reused if both
// React.lazy and prefetch reference the same import factory.
type Loader = () => Promise<unknown>;

const make = <T extends Loader>(loader: T) => {
  const L = lazy(loader as never);
  return { L, prefetch: loader } as { L: ReturnType<typeof lazy>; prefetch: Loader };
};

export const Pages = {
  // Agent
  "/agent/dashboard":   make(() => import("@/pages/agent/Dashboard")),
  "/agent/get-number":  make(() => import("@/pages/agent/GetNumber")),
  "/agent/console":     make(() => import("@/pages/agent/Console")),
  "/agent/my-numbers":  make(() => import("@/pages/agent/MyNumbers")),
  "/agent/history":     make(() => import("@/pages/agent/History")),
  "/agent/summary":     make(() => import("@/pages/agent/Summary")),
  "/agent/payments":    make(() => import("@/pages/agent/Payments")),
  "/agent/profile":     make(() => import("@/pages/agent/Profile")),
  "/agent/leaderboard": make(() => import("@/pages/agent/Leaderboard")),
  "/agent/inbox":       make(() => import("@/pages/agent/Inbox")),
  // Admin
  "/admin/dashboard":         make(() => import("@/pages/admin/Dashboard")),
  "/admin/providers":         make(() => import("@/pages/admin/Providers")),
  "/admin/agents":            make(() => import("@/pages/admin/Agents")),
  "/admin/rates":             make(() => import("@/pages/admin/RateCard")),
  "/admin/allocation":        make(() => import("@/pages/admin/Allocation")),
  "/admin/payments":          make(() => import("@/pages/admin/Payments")),
  "/admin/withdrawals":       make(() => import("@/pages/admin/Withdrawals")),
  "/admin/security":          make(() => import("@/pages/admin/Security")),
  "/admin/cdr":               make(() => import("@/pages/admin/CDR")),
  "/admin/ims-status":        make(() => import("@/pages/admin/ImsStatus")),
  "/admin/msi-status":        make(() => import("@/pages/admin/MsiStatus")),
  "/admin/numpanel-status":   make(() => import("@/pages/admin/NumPanelStatus")),
  "/admin/xisora-status":     make(() => import("@/pages/admin/XisoraStatus")),
  "/admin/provider-settings": make(() => import("@/pages/admin/ProviderSettings")),
  "/admin/tg-bot":            make(() => import("@/pages/admin/TgBot")),
  "/admin/notifications":     make(() => import("@/pages/admin/Notifications")),
} as const;

export type PagePath = keyof typeof Pages;

export const prefetchPage = (path: string) => {
  const entry = (Pages as Record<string, { prefetch: Loader } | undefined>)[path];
  if (entry) entry.prefetch().catch(() => {});
};

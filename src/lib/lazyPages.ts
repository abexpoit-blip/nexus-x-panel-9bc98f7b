import { lazy } from "react";

// Centralized lazy imports + prefetch map. Same chunk is reused if both
// React.lazy and prefetch reference the same import factory.
type Loader = () => Promise<unknown>;

// Wrap a dynamic import so a transient chunk fetch failure (flaky network,
// just-deployed asset still propagating) is retried twice with backoff
// before bubbling up to the RouteBoundary. This eliminates most of the
// "click menu → black screen, need reload" cases.
const withRetry = <T>(loader: () => Promise<T>, retries = 2, delay = 400): (() => Promise<T>) => {
  return () =>
    new Promise<T>((resolve, reject) => {
      const attempt = (left: number, wait: number) => {
        loader()
          .then(resolve)
          .catch((err) => {
            const msg = String(err?.message || err);
            const isChunk = /Loading chunk|Loading CSS chunk|Failed to fetch dynamically imported module|Importing a module script failed/i.test(msg);
            if (left > 0 && isChunk) {
              setTimeout(() => attempt(left - 1, wait * 2), wait);
            } else {
              reject(err);
            }
          });
      };
      attempt(retries, delay);
    });
};

const make = <T extends Loader>(loader: T) => {
  const wrapped = withRetry(loader as () => Promise<unknown>);
  const L = lazy(wrapped as never);
  return { L, prefetch: wrapped } as { L: ReturnType<typeof lazy>; prefetch: Loader };
};

export const Pages = {
  // Agent
  "/agent/dashboard":   make(() => import("@/pages/agent/Dashboard")),
  "/agent/get-number":  make(() => import("@/pages/agent/GetNumber")),
  "/agent/console":     make(() => import("@/pages/agent/Console")),
  "/agent/my-numbers":  make(() => import("@/pages/agent/MyNumbers")),
  "/agent/history":     make(() => import("@/pages/agent/History")),
  "/agent/otp-audit":   make(() => import("@/pages/agent/OtpAudit")),
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
  "/admin/iprn-sms-status":   make(() => import("@/pages/admin/IprnSmsStatus")),
  "/admin/iprn-sms-v2-status": make(() => import("@/pages/admin/IprnSmsV2Status")),
  "/admin/iprn-sms-deliveries":    make(() => import("@/pages/admin/IprnSmsDeliveries")),
  "/admin/iprn-sms-v2-deliveries": make(() => import("@/pages/admin/IprnSmsV2Deliveries")),
  "/admin/seven1tel-status":  make(() => import("@/pages/admin/Seven1telStatus")),
  "/admin/bots":              make(() => import("@/pages/admin/Bots")),
  "/admin/provider-settings": make(() => import("@/pages/admin/ProviderSettings")),
  "/admin/tg-bot":            make(() => import("@/pages/admin/TgBot")),
  "/admin/notifications":     make(() => import("@/pages/admin/Notifications")),
} as const;

export type PagePath = keyof typeof Pages;

export const prefetchPage = (path: string) => {
  const entry = (Pages as Record<string, { prefetch: Loader } | undefined>)[path];
  if (entry) entry.prefetch().catch(() => {});
};

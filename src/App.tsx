import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { lazy, Suspense } from "react";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/AuthContext";
import { NotificationProvider } from "@/contexts/NotificationContext";
import { NotificationPanel } from "@/components/NotificationPanel";
import { AppLayout } from "@/layouts/AppLayout";

// Eager-load auth pages (small + first paint)
import Login from "@/pages/Login";
import Register from "@/pages/Register";
import AdminLogin from "@/pages/AdminLogin";
import NotFound from "@/pages/NotFound";

// Lazy-load all dashboard pages — major perf win, smaller initial bundle
const AgentDashboard = lazy(() => import("@/pages/agent/Dashboard"));
const AgentGetNumber = lazy(() => import("@/pages/agent/GetNumber"));
const AgentConsole = lazy(() => import("@/pages/agent/Console"));
const AgentMyNumbers = lazy(() => import("@/pages/agent/MyNumbers"));
const AgentSummary = lazy(() => import("@/pages/agent/Summary"));
const AgentPayments = lazy(() => import("@/pages/agent/Payments"));
const AgentProfile = lazy(() => import("@/pages/agent/Profile"));
const AgentLeaderboard = lazy(() => import("@/pages/agent/Leaderboard"));
const AgentInbox = lazy(() => import("@/pages/agent/Inbox"));
const AgentHistory = lazy(() => import("@/pages/agent/History"));

const AdminDashboard = lazy(() => import("@/pages/admin/Dashboard"));
const AdminProviders = lazy(() => import("@/pages/admin/Providers"));
const AdminAgents = lazy(() => import("@/pages/admin/Agents"));
const AdminRateCard = lazy(() => import("@/pages/admin/RateCard"));
const AdminAllocation = lazy(() => import("@/pages/admin/Allocation"));
const AdminCDR = lazy(() => import("@/pages/admin/CDR"));
const AdminNotifications = lazy(() => import("@/pages/admin/Notifications"));
const AdminPayments = lazy(() => import("@/pages/admin/Payments"));
const AdminSecurity = lazy(() => import("@/pages/admin/Security"));
const AdminImsStatus = lazy(() => import("@/pages/admin/ImsStatus"));
const AdminMsiStatus = lazy(() => import("@/pages/admin/MsiStatus"));
const AdminProviderSettings = lazy(() => import("@/pages/admin/ProviderSettings"));
const AdminWithdrawals = lazy(() => import("@/pages/admin/Withdrawals"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const PageFallback = () => (
  <div className="flex items-center justify-center min-h-[60vh]">
    <div className="w-8 h-8 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
  </div>
);

const AuthPage = ({ children }: { children: React.ReactNode }) => {
  const location = useLocation();
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={location.pathname}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ type: "tween", ease: [0.25, 0.46, 0.45, 0.94] as [number, number, number, number], duration: 0.3 }}
        className="min-h-screen"
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
};

const AppRoutes = () => {
  const location = useLocation();

  return (
    <Suspense fallback={<PageFallback />}>
      <AnimatePresence mode="wait">
        <Routes location={location} key={location.pathname}>
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/login" element={<AuthPage><Login /></AuthPage>} />
          <Route path="/register" element={<AuthPage><Register /></AuthPage>} />
          {/* Hidden admin entry — not linked from anywhere in the public UI */}
          <Route path="/sys/control-panel" element={<AuthPage><AdminLogin /></AuthPage>} />

          {/* Agent Routes */}
          <Route element={<AppLayout requiredRole="agent" />}>
            <Route path="/agent/dashboard" element={<AgentDashboard />} />
            <Route path="/agent/get-number" element={<AgentGetNumber />} />
            <Route path="/agent/console" element={<AgentConsole />} />
            <Route path="/agent/my-numbers" element={<AgentMyNumbers />} />
            <Route path="/agent/history" element={<AgentHistory />} />
            <Route path="/agent/summary" element={<AgentSummary />} />
            <Route path="/agent/payments" element={<AgentPayments />} />
            <Route path="/agent/profile" element={<AgentProfile />} />
            <Route path="/agent/leaderboard" element={<AgentLeaderboard />} />
            <Route path="/agent/inbox" element={<AgentInbox />} />
          </Route>

          {/* Admin Routes */}
          <Route element={<AppLayout requiredRole="admin" />}>
            <Route path="/admin/dashboard" element={<AdminDashboard />} />
            <Route path="/admin/providers" element={<AdminProviders />} />
            <Route path="/admin/agents" element={<AdminAgents />} />
            <Route path="/admin/rates" element={<AdminRateCard />} />
            <Route path="/admin/allocation" element={<AdminAllocation />} />
            <Route path="/admin/payments" element={<AdminPayments />} />
            <Route path="/admin/withdrawals" element={<AdminWithdrawals />} />
            <Route path="/admin/security" element={<AdminSecurity />} />
            <Route path="/admin/cdr" element={<AdminCDR />} />
            <Route path="/admin/ims-status" element={<AdminImsStatus />} />
            <Route path="/admin/msi-status" element={<AdminMsiStatus />} />
            <Route path="/admin/provider-settings" element={<AdminProviderSettings />} />
            <Route path="/admin/notifications" element={<AdminNotifications />} />
          </Route>

          <Route path="*" element={<NotFound />} />
        </Routes>
      </AnimatePresence>
    </Suspense>
  );
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <AuthProvider>
        <NotificationProvider>
          <BrowserRouter
            future={{
              v7_startTransition: true,
              v7_relativeSplatPath: true,
            }}
          >
            <AppRoutes />
            <NotificationPanel />
          </BrowserRouter>
        </NotificationProvider>
      </AuthProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;

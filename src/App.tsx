import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Suspense } from "react";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/AuthContext";
import { NotificationProvider } from "@/contexts/NotificationContext";
import { NotificationPanel } from "@/components/NotificationPanel";
import { AppLayout } from "@/layouts/AppLayout";
import { Pages } from "@/lib/lazyPages";

// Eager-load auth pages (small + first paint)
import Login from "@/pages/Login";
import Register from "@/pages/Register";
import AdminLogin from "@/pages/AdminLogin";
import NotFound from "@/pages/NotFound";

const AgentDashboard = Pages["/agent/dashboard"].L;
const AgentGetNumber = Pages["/agent/get-number"].L;
const AgentConsole = Pages["/agent/console"].L;
const AgentMyNumbers = Pages["/agent/my-numbers"].L;
const AgentSummary = Pages["/agent/summary"].L;
const AgentPayments = Pages["/agent/payments"].L;
const AgentProfile = Pages["/agent/profile"].L;
const AgentLeaderboard = Pages["/agent/leaderboard"].L;
const AgentInbox = Pages["/agent/inbox"].L;
const AgentHistory = Pages["/agent/history"].L;

const AdminDashboard = Pages["/admin/dashboard"].L;
const AdminProviders = Pages["/admin/providers"].L;
const AdminAgents = Pages["/admin/agents"].L;
const AdminRateCard = Pages["/admin/rates"].L;
const AdminAllocation = Pages["/admin/allocation"].L;
const AdminCDR = Pages["/admin/cdr"].L;
const AdminNotifications = Pages["/admin/notifications"].L;
const AdminPayments = Pages["/admin/payments"].L;
const AdminSecurity = Pages["/admin/security"].L;
const AdminImsStatus = Pages["/admin/ims-status"].L;
const AdminMsiStatus = Pages["/admin/msi-status"].L;
const AdminNumPanelStatus = Pages["/admin/numpanel-status"].L;
const AdminIprnStatus = Pages["/admin/iprn-status"].L;
const AdminProviderSettings = Pages["/admin/provider-settings"].L;
const AdminWithdrawals = Pages["/admin/withdrawals"].L;
const AdminTgBot = Pages["/admin/tg-bot"].L;

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
  <div className="space-y-4 animate-in fade-in duration-150">
    <div className="h-9 w-56 rounded-md bg-white/[0.04]" />
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-24 rounded-xl bg-white/[0.03] border border-white/[0.04]" />
      ))}
    </div>
    <div className="h-64 rounded-xl bg-white/[0.03] border border-white/[0.04]" />
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
            <Route path="/admin/numpanel-status" element={<AdminNumPanelStatus />} />
            <Route path="/admin/iprn-status" element={<AdminIprnStatus />} />
            <Route path="/admin/provider-settings" element={<AdminProviderSettings />} />
            <Route path="/admin/tg-bot" element={<AdminTgBot />} />
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

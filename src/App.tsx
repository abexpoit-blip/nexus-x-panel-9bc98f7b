import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/AuthContext";
import { NotificationProvider } from "@/contexts/NotificationContext";
import { NotificationPanel } from "@/components/NotificationPanel";
import { AppLayout } from "@/layouts/AppLayout";

import Login from "@/pages/Login";
import Register from "@/pages/Register";
import AdminLogin from "@/pages/AdminLogin";
import NotFound from "@/pages/NotFound";

import AgentDashboard from "@/pages/agent/Dashboard";
import AgentGetNumber from "@/pages/agent/GetNumber";
import AgentConsole from "@/pages/agent/Console";
import AgentMyNumbers from "@/pages/agent/MyNumbers";
import AgentSummary from "@/pages/agent/Summary";
import AgentPayments from "@/pages/agent/Payments";
import AgentProfile from "@/pages/agent/Profile";
import AgentLeaderboard from "@/pages/agent/Leaderboard";
import AgentInbox from "@/pages/agent/Inbox";

import AdminDashboard from "@/pages/admin/Dashboard";
import AdminProviders from "@/pages/admin/Providers";
import AdminAgents from "@/pages/admin/Agents";
import AdminRateCard from "@/pages/admin/RateCard";
import AdminAllocation from "@/pages/admin/Allocation";
import AdminCDR from "@/pages/admin/CDR";
import AdminNotifications from "@/pages/admin/Notifications";
import AdminPayments from "@/pages/admin/Payments";
import AdminSecurity from "@/pages/admin/Security";
import AdminImsStatus from "@/pages/admin/ImsStatus";

const queryClient = new QueryClient();

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
          <Route path="/admin/security" element={<AdminSecurity />} />
          <Route path="/admin/cdr" element={<AdminCDR />} />
          <Route path="/admin/ims-status" element={<AdminImsStatus />} />
          <Route path="/admin/notifications" element={<AdminNotifications />} />
        </Route>

        <Route path="*" element={<NotFound />} />
      </Routes>
    </AnimatePresence>
  );
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <AuthProvider>
        <NotificationProvider>
          <BrowserRouter>
            <AppRoutes />
            <NotificationPanel />
          </BrowserRouter>
        </NotificationProvider>
      </AuthProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;

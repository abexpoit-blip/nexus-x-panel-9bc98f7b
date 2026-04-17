import React, { useState, useCallback, useEffect } from "react";
import { api, tokenStore } from "@/lib/api";
import { AuthContext, type User } from "./auth-context";

export { useAuth } from "@/hooks/useAuth";
export type { UserRole, User, AuthContextType } from "./auth-context";

const IMP_KEY = "nexus_impersonator";

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(() => {
    const stored = localStorage.getItem("nexus_user");
    return stored ? JSON.parse(stored) : null;
  });
  const [impersonator, setImpersonator] = useState<{ id: number; username: string } | null>(() => {
    const s = localStorage.getItem(IMP_KEY);
    return s ? JSON.parse(s) : null;
  });

  // Re-validate token + sync impersonation flag on mount
  useEffect(() => {
    if (!tokenStore.get()) return;
    api.me().then(({ user, impersonator }) => {
      setUser(user);
      localStorage.setItem("nexus_user", JSON.stringify(user));
      if (impersonator) {
        setImpersonator(impersonator);
        localStorage.setItem(IMP_KEY, JSON.stringify(impersonator));
      } else {
        setImpersonator(null);
        localStorage.removeItem(IMP_KEY);
      }
    }).catch(() => {
      tokenStore.clear();
      localStorage.removeItem("nexus_user");
      localStorage.removeItem(IMP_KEY);
      setUser(null);
      setImpersonator(null);
    });
  }, []);

  const [signupEnabled, setSignupEnabledState] = useState(() => {
    return localStorage.getItem("nexus_signup_enabled") !== "false";
  });
  const [maintenanceMode, setMaintenanceModeState] = useState(() => {
    return localStorage.getItem("nexus_maintenance_mode") === "true";
  });
  const [maintenanceMessage, setMaintenanceMessageState] = useState(() => {
    return localStorage.getItem("nexus_maintenance_message") || "System is under maintenance. Please try again later.";
  });

  useEffect(() => {
    api.settings.getPublic().then((s: any) => {
      if (typeof s.maintenance_mode === "boolean") {
        setMaintenanceModeState(s.maintenance_mode);
        localStorage.setItem("nexus_maintenance_mode", String(s.maintenance_mode));
      }
      if (s.maintenance_message) {
        setMaintenanceMessageState(s.maintenance_message);
        localStorage.setItem("nexus_maintenance_message", s.maintenance_message);
      }
    }).catch(() => {});
  }, []);

  const login = useCallback(async (username: string, password: string): Promise<boolean> => {
    try {
      const { token, user } = await api.login(username, password);
      tokenStore.set(token);
      localStorage.setItem("nexus_user", JSON.stringify(user));
      localStorage.removeItem(IMP_KEY);
      setUser(user);
      setImpersonator(null);
      return true;
    } catch {
      return false;
    }
  }, []);

  const logout = useCallback(() => {
    api.logout?.().catch(() => {});
    tokenStore.clear();
    localStorage.removeItem("nexus_user");
    localStorage.removeItem(IMP_KEY);
    setUser(null);
    setImpersonator(null);
  }, []);

  const loginAsAgent = useCallback(async (agentId: number): Promise<boolean> => {
    try {
      const { token, user, impersonator } = await api.admin.loginAs(agentId);
      tokenStore.set(token);
      localStorage.setItem("nexus_user", JSON.stringify(user));
      localStorage.setItem(IMP_KEY, JSON.stringify(impersonator));
      setUser(user);
      setImpersonator(impersonator);
      return true;
    } catch {
      return false;
    }
  }, []);

  const exitImpersonation = useCallback(async () => {
    try {
      const { token, user } = await api.exitImpersonation();
      tokenStore.set(token);
      localStorage.setItem("nexus_user", JSON.stringify(user));
      localStorage.removeItem(IMP_KEY);
      setUser(user);
      setImpersonator(null);
    } catch {
      // fallback — force admin login
      logout();
    }
  }, [logout]);

  const setSignupEnabled = useCallback((enabled: boolean) => {
    setSignupEnabledState(enabled);
    localStorage.setItem("nexus_signup_enabled", String(enabled));
    api.settings.set("signup_enabled", String(enabled)).catch(() => {});
  }, []);

  const setMaintenanceMode = useCallback((enabled: boolean, message?: string) => {
    setMaintenanceModeState(enabled);
    localStorage.setItem("nexus_maintenance_mode", String(enabled));
    api.settings.set("maintenance_mode", String(enabled)).catch(() => {});
    if (message !== undefined) {
      setMaintenanceMessageState(message);
      localStorage.setItem("nexus_maintenance_message", message);
      api.settings.set("maintenance_message", message).catch(() => {});
    }
  }, []);

  return (
    <AuthContext.Provider value={{
      user, isAuthenticated: !!user, login, logout,
      signupEnabled, setSignupEnabled,
      maintenanceMode, maintenanceMessage, setMaintenanceMode,
      impersonator, loginAsAgent, exitImpersonation,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

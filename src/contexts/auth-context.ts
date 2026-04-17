import { createContext } from "react";

export type UserRole = "admin" | "agent";

export interface User {
  id: number;
  username: string;
  role: UserRole;
  balance: number;
  otp_count: number;
  daily_limit?: number;
  per_request_limit?: number;
  full_name?: string;
  phone?: string;
  telegram?: string;
}

export interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
  signupEnabled: boolean;
  setSignupEnabled: (enabled: boolean) => void;
  maintenanceMode: boolean;
  maintenanceMessage: string;
  setMaintenanceMode: (enabled: boolean, message?: string) => void;
  // Impersonation
  impersonator: { id: number; username: string } | null;
  loginAsAgent: (agentId: number) => Promise<boolean>;
  exitImpersonation: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextType | null>(null);

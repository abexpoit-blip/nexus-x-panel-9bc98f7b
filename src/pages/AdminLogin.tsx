import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { NexusLogo } from "@/components/NexusLogo";
import { ParticleCanvas } from "@/components/ParticleCanvas";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Eye, EyeOff, ShieldCheck, Lock } from "lucide-react";
import { motion } from "framer-motion";
import { APP_VERSION } from "@/components/NexusLogo";

const AdminLogin = () => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    const loggedInUser = await login(username, password);
    setLoading(false);
    if (!loggedInUser) {
      setError("Invalid credentials");
      return;
    }
    if (loggedInUser.role !== "admin") {
      setError("This portal is for administrators only");
      return;
    }
    navigate("/admin/dashboard");
  };

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden px-4 bg-background">
      <ParticleCanvas />
      <div className="absolute top-1/4 -left-32 w-[500px] h-[500px] rounded-full bg-neon-magenta/[0.08] blur-[120px] animate-pulse" />
      <div className="absolute bottom-1/4 -right-32 w-[500px] h-[500px] rounded-full bg-neon-amber/[0.06] blur-[120px] animate-pulse" style={{ animationDelay: "1s" }} />

      <motion.div
        initial={{ opacity: 0, y: 30, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-10 w-full max-w-md"
      >
        <div className="glass-card p-8 md:p-10 neon-glow-magenta relative overflow-hidden">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-3/4 h-px bg-gradient-to-r from-transparent via-neon-magenta to-transparent" />

          <div className="flex flex-col items-center mb-8">
            <NexusLogo size="md" />
            <div className="flex items-center gap-2 justify-center mt-4">
              <ShieldCheck className="w-3.5 h-3.5 text-neon-magenta" />
              <span className="text-[10px] uppercase tracking-[0.3em] text-neon-magenta font-semibold">Restricted · Admin Portal</span>
            </div>
            <p className="text-xs text-muted-foreground/60 mt-2 font-mono">Authorized personnel only</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Admin Username</label>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin@nexus"
                autoComplete="off"
                className="bg-white/[0.04] border-white/[0.08] focus:border-neon-magenta/50 h-12 text-sm"
                required
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Password</label>
              <div className="relative">
                <Input
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="off"
                  className="bg-white/[0.04] border-white/[0.08] focus:border-neon-magenta/50 h-12 text-sm pr-10"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPw(!showPw)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && <p className="text-sm text-neon-red font-medium">{error}</p>}

            <Button
              type="submit"
              disabled={loading}
              className="w-full h-12 bg-gradient-to-r from-neon-magenta to-neon-amber text-primary-foreground font-semibold hover:opacity-90 border-0"
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
              ) : (
                <>
                  <Lock className="w-4 h-4 mr-2" />
                  Access Control Panel
                </>
              )}
            </Button>
          </form>

          <div className="mt-6 pt-4 border-t border-white/[0.04] text-center">
            <p className="text-[10px] text-muted-foreground/40 font-mono">
              Nexus X {APP_VERSION} · Secure Admin Gateway
            </p>
          </div>
        </div>
      </motion.div>
    </div>
  );
};

export default AdminLogin;

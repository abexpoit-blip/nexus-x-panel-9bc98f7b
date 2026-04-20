import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { NexusLogo } from "@/components/NexusLogo";
import { ParticleCanvas } from "@/components/ParticleCanvas";
import { Typewriter } from "@/components/Typewriter";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Eye, EyeOff, LogIn, Sparkles } from "lucide-react";
import { motion } from "framer-motion";
import { APP_VERSION } from "@/components/NexusLogo";

const Login = () => {
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
      setError("Invalid username or password");
      return;
    }
    if (loggedInUser.role === "admin") {
      // Admins must use the dedicated admin portal — block here for separation
      setError("Admins must sign in via the admin portal");
      return;
    }
    navigate("/agent/dashboard");
  };

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden px-4">
      {/* Particle background */}
      <ParticleCanvas />

      {/* Gradient orbs */}
      <div className="absolute top-1/4 -left-32 w-[500px] h-[500px] rounded-full bg-neon-cyan/[0.06] blur-[120px] animate-pulse" />
      <div className="absolute bottom-1/4 -right-32 w-[500px] h-[500px] rounded-full bg-neon-magenta/[0.06] blur-[120px] animate-pulse" style={{ animationDelay: "1s" }} />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[300px] h-[300px] rounded-full bg-primary/[0.03] blur-[80px]" />

      {/* Grid overlay */}
      <div
        className="absolute inset-0 opacity-[0.02]"
        style={{
          backgroundImage: `linear-gradient(hsl(185 100% 50% / 0.4) 1px, transparent 1px), linear-gradient(90deg, hsl(185 100% 50% / 0.4) 1px, transparent 1px)`,
          backgroundSize: "50px 50px",
        }}
      />

      <motion.div
        initial={{ opacity: 0, y: 30, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-10 w-full max-w-md"
      >
        <div className="glass-card p-8 md:p-10 neon-glow-cyan relative overflow-hidden">
          {/* Decorative top glow line */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-3/4 h-px bg-gradient-to-r from-transparent via-primary to-transparent" />

          <div className="flex flex-col items-center mb-8">
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.2, duration: 0.6 }}
            >
              <NexusLogo size="lg" />
            </motion.div>

            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5 }}
              className="mt-4 text-center"
            >
              <div className="flex items-center gap-2 justify-center mb-2">
                <Sparkles className="w-3.5 h-3.5 text-neon-amber" />
                <span className="text-[10px] uppercase tracking-[0.3em] text-neon-amber font-semibold">Premium Platform</span>
                <Sparkles className="w-3.5 h-3.5 text-neon-amber" />
              </div>
              <p className="text-sm text-muted-foreground h-5">
                <Typewriter
                  texts={[
                    "IPRN & SMS Number Panel",
                    "World-Class OTP Management",
                    "Built for Performance",
                    "Secure. Fast. Reliable.",
                  ]}
                  speed={60}
                  deleteSpeed={30}
                  pauseTime={2500}
                />
              </p>
            </motion.div>
          </div>

          <motion.form
            onSubmit={handleSubmit}
            className="space-y-5"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4, duration: 0.5 }}
          >
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Username</label>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter your username"
                className="bg-white/[0.04] border-white/[0.08] focus:border-primary/50 h-12 text-sm placeholder:text-muted-foreground/40"
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
                  placeholder="Enter your password"
                  className="bg-white/[0.04] border-white/[0.08] focus:border-primary/50 h-12 text-sm pr-10 placeholder:text-muted-foreground/40"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPw(!showPw)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && (
              <motion.p
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                className="text-sm text-neon-red font-medium"
              >
                {error}
              </motion.p>
            )}

            <Button
              type="submit"
              disabled={loading}
              className="w-full h-12 bg-gradient-to-r from-primary via-primary to-neon-magenta text-primary-foreground font-semibold hover:opacity-90 transition-all border-0 text-sm tracking-wide relative overflow-hidden group"
            >
              <div className="absolute inset-0 bg-gradient-to-r from-neon-magenta/0 via-white/10 to-neon-magenta/0 translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700" />
              {loading ? (
                <div className="w-5 h-5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
              ) : (
                <>
                  <LogIn className="w-4 h-4 mr-2" />
                  Sign In to Nexus X
                </>
              )}
            </Button>
          </motion.form>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.7 }}
            className="mt-6 space-y-3"
          >
            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-white/[0.06]" />
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50">or</span>
              <div className="flex-1 h-px bg-white/[0.06]" />
            </div>
            <Link to="/register">
              <Button
                variant="outline"
                className="w-full h-11 glass border-white/[0.08] hover:bg-white/[0.06] hover:border-primary/30 text-sm text-muted-foreground hover:text-foreground transition-all"
              >
                Create New Account
              </Button>
            </Link>
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.9 }}
            className="mt-6 pt-4 border-t border-white/[0.04] text-center"
          >
            <p className="text-[10px] text-muted-foreground/40 font-mono">
              Nexus X {APP_VERSION} — Developed by Shovon
            </p>
          </motion.div>
        </div>
      </motion.div>
    </div>
  );
};

export default Login;

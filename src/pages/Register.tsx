import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { NexusLogo } from "@/components/NexusLogo";
import { ParticleCanvas } from "@/components/ParticleCanvas";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Eye, EyeOff, UserPlus, Sparkles, ShieldX, User, Phone, Send, Lock, AtSign } from "lucide-react";
import { motion } from "framer-motion";
import { toast } from "@/hooks/use-toast";
import { APP_VERSION } from "@/components/NexusLogo";
import { api } from "@/lib/api";

const Register = () => {
  const [form, setForm] = useState({
    name: "",
    username: "",
    telegram: "",
    phone: "",
    password: "",
    confirmPassword: "",
  });
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [signupEnabled, setSignupEnabled] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    // Fetch real signup_enabled flag from backend
    api.settings.getPublic()
      .then((s) => setSignupEnabled(!!s.signup_enabled))
      .catch(() => setSignupEnabled(true)); // fallback open
  }, []);

  const update = (key: string, value: string) => setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signupEnabled) return;

    if (form.password !== form.confirmPassword) {
      toast({ title: "Error", description: "Passwords do not match", variant: "destructive" });
      return;
    }
    if (form.password.length < 8) {
      toast({ title: "Error", description: "Password must be at least 8 characters", variant: "destructive" });
      return;
    }
    if (!form.telegram.startsWith("@")) {
      toast({ title: "Error", description: "Telegram username must start with @", variant: "destructive" });
      return;
    }

    setLoading(true);
    try {
      await api.register({
        username: form.username,
        password: form.password,
        full_name: form.name,
        phone: form.phone,
        telegram: form.telegram,
      });
      toast({
        title: "Registration Submitted!",
        description: "Your account is pending admin approval. You'll be notified once approved.",
      });
      navigate("/login");
    } catch (err: any) {
      toast({ title: "Registration failed", description: err?.message || "Please try again", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden px-4 py-8">
      <ParticleCanvas />

      <div className="absolute top-1/4 -left-32 w-[500px] h-[500px] rounded-full bg-neon-cyan/[0.06] blur-[120px] animate-pulse" />
      <div className="absolute bottom-1/4 -right-32 w-[500px] h-[500px] rounded-full bg-neon-magenta/[0.06] blur-[120px] animate-pulse" style={{ animationDelay: "1s" }} />

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
        className="relative z-10 w-full max-w-lg"
      >
        <div className="glass-card p-8 md:p-10 neon-glow-cyan relative overflow-hidden">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-3/4 h-px bg-gradient-to-r from-transparent via-neon-magenta to-transparent" />

          <div className="flex flex-col items-center mb-6">
            <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.2 }}>
              <NexusLogo size="md" />
            </motion.div>
            <div className="flex items-center gap-2 justify-center mt-3">
              <Sparkles className="w-3.5 h-3.5 text-neon-amber" />
              <span className="text-[10px] uppercase tracking-[0.3em] text-neon-amber font-semibold">Join Nexus X</span>
              <Sparkles className="w-3.5 h-3.5 text-neon-amber" />
            </div>
            <p className="text-sm text-muted-foreground mt-2">Create your agent account</p>
          </div>

          {!signupEnabled ? (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="text-center py-12 space-y-4"
            >
              <div className="w-20 h-20 mx-auto rounded-2xl bg-neon-red/10 flex items-center justify-center">
                <ShieldX className="w-10 h-10 text-neon-red" />
              </div>
              <h3 className="text-xl font-display font-bold text-foreground">Registration Closed</h3>
              <p className="text-sm text-muted-foreground max-w-xs mx-auto">
                New account registration is currently disabled by the administrator. Please check back later or contact support.
              </p>
              <Link to="/login">
                <Button variant="outline" className="mt-4 glass border-white/[0.08] hover:bg-white/[0.06]">
                  Back to Login
                </Button>
              </Link>
            </motion.div>
          ) : (
            <motion.form
              onSubmit={handleSubmit}
              className="space-y-4"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <User className="w-3 h-3" /> Full Name
                  </label>
                  <Input
                    value={form.name}
                    onChange={(e) => update("name", e.target.value)}
                    placeholder="Your full name"
                    className="bg-white/[0.04] border-white/[0.08] focus:border-primary/50 h-11 text-sm"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <AtSign className="w-3 h-3" /> Username
                  </label>
                  <Input
                    value={form.username}
                    onChange={(e) => update("username", e.target.value)}
                    placeholder="Choose a username"
                    className="bg-white/[0.04] border-white/[0.08] focus:border-primary/50 h-11 text-sm"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <Send className="w-3 h-3" /> Telegram
                  </label>
                  <Input
                    value={form.telegram}
                    onChange={(e) => update("telegram", e.target.value)}
                    placeholder="@your_telegram"
                    className="bg-white/[0.04] border-white/[0.08] focus:border-primary/50 h-11 text-sm"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <Phone className="w-3 h-3" /> Phone Number
                  </label>
                  <Input
                    value={form.phone}
                    onChange={(e) => update("phone", e.target.value)}
                    placeholder="+880..."
                    className="bg-white/[0.04] border-white/[0.08] focus:border-primary/50 h-11 text-sm"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <Lock className="w-3 h-3" /> Password
                  </label>
                  <div className="relative">
                    <Input
                      type={showPw ? "text" : "password"}
                      value={form.password}
                      onChange={(e) => update("password", e.target.value)}
                      placeholder="Min 6 characters"
                      className="bg-white/[0.04] border-white/[0.08] focus:border-primary/50 h-11 text-sm pr-10"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowPw(!showPw)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showPw ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <Lock className="w-3 h-3" /> Confirm Password
                  </label>
                  <Input
                    type={showPw ? "text" : "password"}
                    value={form.confirmPassword}
                    onChange={(e) => update("confirmPassword", e.target.value)}
                    placeholder="Re-enter password"
                    className="bg-white/[0.04] border-white/[0.08] focus:border-primary/50 h-11 text-sm"
                    required
                  />
                </div>
              </div>

              <div className="pt-2">
                <Button
                  type="submit"
                  disabled={loading}
                  className="w-full h-12 bg-gradient-to-r from-neon-magenta via-primary to-neon-cyan text-primary-foreground font-semibold hover:opacity-90 transition-all border-0 text-sm tracking-wide relative overflow-hidden group"
                >
                  <div className="absolute inset-0 bg-gradient-to-r from-white/0 via-white/10 to-white/0 translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700" />
                  {loading ? (
                    <div className="w-5 h-5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                  ) : (
                    <>
                      <UserPlus className="w-4 h-4 mr-2" />
                      Create Account
                    </>
                  )}
                </Button>
              </div>

              <p className="text-[11px] text-muted-foreground/60 text-center">
                By registering, your account will be reviewed and approved by an admin before activation.
              </p>
            </motion.form>
          )}

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6 }}
            className="mt-5 text-center"
          >
            <p className="text-xs text-muted-foreground">
              Already have an account?{" "}
              <Link to="/login" className="text-primary hover:text-primary/80 font-semibold transition-colors">
                Sign In
              </Link>
            </p>
          </motion.div>

          <div className="mt-4 pt-3 border-t border-white/[0.04] text-center">
            <p className="text-[10px] text-muted-foreground/40 font-mono">
              Nexus X {APP_VERSION} — Premium IPRN Platform
            </p>
          </div>
        </div>
      </motion.div>
    </div>
  );
};

export default Register;

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { GradientMesh, PageHeader } from "@/components/premium";
import {
  Bot, CheckCircle2, XCircle, Activity, Database, MessageSquareText,
  RefreshCw, Power, Play, Square, Save, Eye, EyeOff, Zap, Sparkles, Layers,
  Clock, ClipboardPaste, Plus, Info, AlertTriangle, Edit3, Trash2, ArrowUp, ArrowDown, Tag, Hash,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type NumPanelStatusT = {
  enabled: boolean;
  running: boolean;
  loggedIn: boolean;
  lastLoginAt: number | null;
  lastScrapeAt: number | null;
  lastScrapeOk: boolean;
  lastNumbersScrapeAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  totalScrapes: number;
  numbersScrapedTotal: number;
  numbersAddedTotal: number;
  otpsDeliveredTotal: number;
  consecFail: number;
  baseUrl: string;
  otpIntervalSec: number;
  numbersIntervalSec: number;
  poolSize: number;
  claimingSize: number;
  activeAssigned: number;
  otpReceived: number;
  otpCacheSize: number;
  events?: { ts: number; level: string; message: string; meta: unknown }[];
  emptyStreak?: number;
  emptyLimit?: number;
  cookieFailStreak?: number;
  hasCookies?: boolean;
};

// ---- Reusable lock-reveal wrapper for sensitive sections ----
// Hides the wrapped content behind a click-to-reveal screen and auto-locks
// after `autoLockSec` seconds of being open (default 60s) for shoulder-surf safety.
const LockReveal = ({
  title, subtitle, icon, accent = "neon-cyan", autoLockSec = 60, children,
}: {
  title: string; subtitle?: string; icon?: React.ReactNode;
  accent?: string; autoLockSec?: number; children: React.ReactNode;
}) => {
  const [unlocked, setUnlocked] = useState(false);
  const [remaining, setRemaining] = useState(autoLockSec);
  useEffect(() => {
    if (!unlocked) return;
    setRemaining(autoLockSec);
    const t = setInterval(() => {
      setRemaining(r => {
        if (r <= 1) { setUnlocked(false); return autoLockSec; }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [unlocked, autoLockSec]);

  if (!unlocked) {
    return (
      <div className={cn("glass-card border border-white/[0.06] rounded-xl p-5 flex items-center justify-between gap-4")}>
        <div className="flex items-center gap-3 min-w-0">
          <div className={cn("w-10 h-10 rounded-lg flex items-center justify-center shrink-0",
            `bg-${accent}/10 border border-${accent}/20`)}>
            {icon ?? <EyeOff className={cn("w-4 h-4", `text-${accent}`)} />}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold flex items-center gap-2">
              {title}
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/[0.05] text-muted-foreground font-bold">
                Hidden
              </span>
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {subtitle || "Sensitive — click to reveal. Auto-hides after 60s."}
            </div>
          </div>
        </div>
        <button
          onClick={() => setUnlocked(true)}
          className={cn("inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold transition shrink-0",
            `bg-${accent}/10 border border-${accent}/30 text-${accent} hover:bg-${accent}/20`)}
        >
          <Eye className="w-3.5 h-3.5" /> Reveal
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Clock className="w-3 h-3" />
        Auto-locking in {remaining}s
        <button onClick={() => setUnlocked(false)}
          className="inline-flex items-center gap-1 px-2 py-1 rounded bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] transition">
          <EyeOff className="w-3 h-3" /> Lock now
        </button>
      </div>
      {children}
    </div>
  );
};

const fmtAgo = (ts: number | null) => {
  if (!ts) return "never";
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const Pill = ({ ok, label }: { ok: boolean; label: string }) => (
  <span className={cn(
    "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold uppercase tracking-wide",
    ok ? "bg-neon-green/15 text-neon-green" : "bg-destructive/15 text-destructive"
  )}>
    {ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
    {label}
  </span>
);

const Stat = ({ icon, label, value, hint, accent }: {
  icon: React.ReactNode; label: string; value: string | number; hint?: string; accent?: string;
}) => (
  <div className="glass-card border border-white/[0.06] rounded-xl p-4">
    <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground mb-2">
      {icon}<span>{label}</span>
    </div>
    <div className={cn("text-2xl font-bold font-mono", accent || "text-foreground")}>{value}</div>
    {hint && <div className="text-xs text-muted-foreground mt-1">{hint}</div>}
  </div>
);

const Row = ({ label, value, mono, accent }: { label: string; value: string; mono?: boolean; accent?: string }) => (
  <div className="flex items-center justify-between gap-3">
    <span className="text-muted-foreground text-xs">{label}</span>
    <span className={cn("text-sm", mono && "font-mono", accent || "text-foreground")}>{value}</span>
  </div>
);

const CredentialsEditor = ({ onSaved }: { onSaved: () => void }) => {
  const [creds, setCreds] = useState<{ enabled: boolean; base_url: string; username: string; password: string; password_masked: string; has_password: boolean }>({
    enabled: false, base_url: "", username: "", password: "", password_masked: "", has_password: false,
  });
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.admin.numpanelCredentials().then(d => setCreds(c => ({ ...c, ...d, password: "" }))).catch(() => {});
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.admin.numpanelCredentialsSave({
        username: creds.username || undefined,
        password: creds.password || undefined,
        base_url: creds.base_url || undefined,
        enabled: creds.enabled,
      });
      toast.success("MSI credentials saved — bot restarting");
      setCreds(c => ({ ...c, password: "" }));
      onSaved();
    } catch (e) {
      toast.error("Save failed: " + (e as Error).message);
    } finally { setSaving(false); }
  };

  return (
    <div className="glass-card border border-white/[0.06] rounded-xl p-5 space-y-4">
      <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        <Layers className="w-3.5 h-3.5 text-neon-cyan" /> NumPanel Credentials
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex items-center gap-2 text-xs text-muted-foreground sm:col-span-2">
          <input type="checkbox" checked={creds.enabled} onChange={e => setCreds(c => ({ ...c, enabled: e.target.checked }))} />
          Enable NumPanel bot
        </label>
        <div>
          <div className="text-xs text-muted-foreground mb-1">Base URL</div>
          <input
            type="text" value={creds.base_url}
            onChange={e => setCreds(c => ({ ...c, base_url: e.target.value }))}
            placeholder="http://51.89.99.105"
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-md px-3 py-2 text-sm font-mono"
          />
        </div>
        <div>
          <div className="text-xs text-muted-foreground mb-1">Username</div>
          <input
            type="text" value={creds.username}
            onChange={e => setCreds(c => ({ ...c, username: e.target.value }))}
            placeholder="ahmed1258"
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-md px-3 py-2 text-sm font-mono"
          />
        </div>
        <div className="sm:col-span-2">
          <div className="text-xs text-muted-foreground mb-1">
            Password {creds.has_password && <span className="text-neon-green">(saved: {creds.password_masked})</span>}
          </div>
          <div className="relative">
            <input
              type={showPw ? "text" : "password"} value={creds.password}
              onChange={e => setCreds(c => ({ ...c, password: e.target.value }))}
              placeholder={creds.has_password ? "Leave blank to keep current" : "Enter password"}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-md px-3 py-2 text-sm font-mono pr-10"
            />
            <button type="button" onClick={() => setShowPw(s => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
      <button
        onClick={handleSave} disabled={saving}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-neon-cyan/10 border border-neon-cyan/30 text-neon-cyan hover:bg-neon-cyan/20 transition disabled:opacity-50"
      >
        <Save className={cn("w-3.5 h-3.5", saving && "animate-pulse")} /> {saving ? "Saving…" : "Save & Restart Bot"}
      </button>
    </div>
  );
};

// ---- NumPanel Session Cookies (mirrors IMS cookie bypass) ----
const NumPanelCookiesEditor = ({ onSaved, cookieFailStreak = 0 }: { onSaved: () => void; cookieFailStreak?: number }) => {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const { data, refetch } = useQuery({
    queryKey: ["numpanel-cookies-status"],
    queryFn: () => api.admin.numpanelCookiesStatus(),
    refetchInterval: 15000,
  });

  const save = async () => {
    if (!raw.trim()) { toast.error("Paste cookies first"); return; }
    setSaving(true);
    try {
      await api.admin.numpanelCookiesSave(raw.trim());
      toast.success("Cookies saved — bot restarting and will skip captcha");
      setRaw("");
      refetch();
      setTimeout(onSaved, 2000);
    } catch (e) {
      toast.error("Save failed: " + (e as Error).message);
    } finally { setSaving(false); }
  };

  const clear = async () => {
    if (!confirm("Clear saved MSI cookies? Bot will fall back to captcha login on next start.")) return;
    setClearing(true);
    try {
      await api.admin.numpanelCookiesClear();
      toast.success("Cookies cleared — bot restarting");
      refetch();
      setTimeout(onSaved, 2000);
    } catch (e) {
      toast.error("Clear failed: " + (e as Error).message);
    } finally { setClearing(false); }
  };

  return (
    <div className="glass-card border border-white/[0.06] rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between p-4 hover:bg-white/[0.02] transition"
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-neon-purple/10 border border-neon-purple/20 flex items-center justify-center">
            <ClipboardPaste className="w-4 h-4 text-neon-purple" />
          </div>
          <div className="text-left">
            <div className="text-sm font-semibold flex items-center gap-2">
              NumPanel Session Cookies
              {cookieFailStreak >= 3 ? (
                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-destructive/20 text-destructive font-bold animate-pulse">
                  ⚠ Expired — Refresh
                </span>
              ) : (
                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-neon-purple/15 text-neon-purple font-bold">
                  Skip Captcha
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {data ? (
                data.has_cookies ? (
                  <>
                    {cookieFailStreak >= 3 ? (
                      <span className="text-destructive font-medium">✗ Cookies stopped working ({cookieFailStreak} fails) — paste fresh ones</span>
                    ) : (
                      <span className="text-neon-green">✓ {data.count} cookies saved</span>
                    )}
                    {data.saved_at && <> · {fmtAgo(data.saved_at)}</>}
                  </>
                ) : (
                  <span className="text-muted-foreground">No cookies saved — using captcha login (bot auto-saves on first successful login)</span>
                )
              ) : "Loading…"}
            </div>
          </div>
        </div>
        <span className="text-xs text-muted-foreground">{open ? "Hide" : data?.has_cookies ? "Update" : "Add"}</span>
      </button>

      {open && (
        <div className="border-t border-white/[0.06] p-5 space-y-4 bg-black/20">
          <div className="text-xs text-muted-foreground space-y-2 bg-neon-purple/5 border border-neon-purple/20 rounded-lg p-3">
            <div className="font-semibold text-neon-purple flex items-center gap-2">
              <Info className="w-3.5 h-3.5" /> How to copy cookies (one-time, lasts weeks)
            </div>
            <ol className="list-decimal list-inside space-y-1 ml-1 text-foreground/80">
              <li>Open <code className="px-1 py-0.5 rounded bg-black/40 font-mono text-[11px]">http://51.89.99.105/NumberPanel/agent/login</code> in Chrome and login normally (solve the math captcha)</li>
              <li>Press <kbd className="px-1.5 py-0.5 rounded bg-black/40 border border-white/10 font-mono text-[10px]">F12</kbd> → <b>Application</b> tab → <b>Cookies</b> → click <code className="px-1 py-0.5 rounded bg-black/40 font-mono text-[11px]">http://51.89.99.105</code></li>
              <li>Select all rows (Ctrl+A) → right-click → <b>Copy</b>, OR use the <b>"EditThisCookie"</b> Chrome extension → export JSON</li>
              <li>Paste below and click Save. Bot restarts and skips captcha.</li>
              <li><b>Note:</b> The bot will auto-save fresh cookies the first time it logs in successfully via captcha — so you may not need to paste anything.</li>
            </ol>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs uppercase tracking-wider text-muted-foreground">
              Cookies (JSON array OR &quot;name=value; name=value&quot; format)
            </label>
            <textarea
              value={raw}
              onChange={e => setRaw(e.target.value)}
              rows={6}
              placeholder={'Paste either:\n[{"name":"PHPSESSID","value":"abc123","domain":"145.239.130.45",...}, ...]\n\nOR\n\nPHPSESSID=abc123; remember_me=xyz; ...'}
              className="w-full bg-black/40 border border-white/[0.08] rounded-md px-3 py-2 text-xs font-mono focus:border-neon-purple/50 outline-none resize-y"
            />
          </div>

          <div className="flex justify-between gap-2 pt-2 flex-wrap">
            <button
              onClick={clear}
              disabled={clearing || !data?.has_cookies}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-destructive/10 border border-destructive/30 text-destructive hover:bg-destructive/20 transition disabled:opacity-40"
            >
              {clearing ? "Clearing…" : "Clear Saved Cookies"}
            </button>
            <div className="flex gap-2">
              <button
                onClick={() => { setOpen(false); setRaw(""); }}
                className="px-4 py-2 rounded-md text-xs font-semibold bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] transition"
              >
                Cancel
              </button>
              <button
                onClick={save}
                disabled={saving || !raw.trim()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-xs font-semibold bg-neon-purple/10 border border-neon-purple/30 text-neon-purple hover:bg-neon-purple/20 transition disabled:opacity-50"
              >
                <Save className={cn("w-3.5 h-3.5", saving && "animate-pulse")} />
                {saving ? "Saving & restarting…" : "Save & Restart Bot"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ---- OTP poll interval setting ----
const NumPanelOtpIntervalSetting = ({ onSaved }: { onSaved: () => void }) => {
  const [saving, setSaving] = useState(false);
  const { data, refetch, isLoading } = useQuery({
    queryKey: ["numpanel-otp-interval"],
    queryFn: () => api.admin.numpanelOtpInterval(),
  });
  const current = data?.interval_sec ?? 5;
  const opts = data?.options ?? [3, 5, 10, 30];

  const save = async (sec: number) => {
    if (sec === current) return;
    setSaving(true);
    try {
      await api.admin.numpanelOtpIntervalSave(sec);
      toast.success(`OTP poll set to ${sec}s — bot restarting`);
      await refetch();
      onSaved();
    } catch (e) { toast.error("Failed: " + (e as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <div className="glass-card border border-white/[0.06] rounded-xl p-5 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Clock className="w-4 h-4 text-neon-cyan" /> OTP Poll Interval
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            How often the bot polls the NumPanel CDR API for new OTPs. Lower = faster delivery (API has no rate limit).
            {data && (
              <span className="ml-2 font-mono">
                Current: <span className="text-neon-cyan font-semibold">{current}s</span>
                <span className="text-muted-foreground/60"> ({data.source})</span>
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {opts.map(v => (
            <button key={v} onClick={() => save(v)} disabled={saving || isLoading}
              className={cn(
                "px-4 py-2 rounded-md text-xs font-semibold border transition disabled:opacity-50",
                v === current
                  ? "bg-neon-cyan/15 border-neon-cyan/40 text-neon-cyan"
                  : "bg-white/[0.04] border-white/[0.08] text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
              )}>
              {v}s
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};



// ---- API Token editor (NumPanel-specific — for CDR API polling) ----
const NumPanelApiTokenEditor = ({ onSaved }: { onSaved: () => void }) => {
  const [token, setToken] = useState("");
  const [apiBase, setApiBase] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const { data, refetch } = useQuery({
    queryKey: ["numpanel-api-token"],
    queryFn: () => api.admin.numpanelApiToken(),
  });

  useEffect(() => {
    if (data?.api_base && !apiBase) setApiBase(data.api_base);
  }, [data, apiBase]);

  const save = async () => {
    if (!token.trim() && !apiBase.trim()) { toast.error("Nothing to save"); return; }
    setSaving(true);
    try {
      await api.admin.numpanelApiTokenSave({
        api_token: token.trim() || undefined,
        api_base: apiBase.trim() || undefined,
      });
      toast.success("API token saved — bot restarting");
      setToken("");
      refetch();
      onSaved();
    } catch (e) { toast.error("Save failed: " + (e as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <div className="glass-card border border-white/[0.06] rounded-xl p-5 space-y-4">
      <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        <Zap className="w-3.5 h-3.5 text-neon-amber" /> CDR API Token
        {data?.has_token && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-neon-green/15 text-neon-green font-bold">
            ✓ saved: {data.token_masked}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Get this from <code className="px-1 py-0.5 rounded bg-black/40 font-mono text-[11px]">http://51.89.99.105/NumberPanel/agent/API</code>.
        Used to fetch OTPs from <code className="px-1 py-0.5 rounded bg-black/40 font-mono text-[11px]">/crapi/st/viewstats</code> with no rate limit.
      </p>
      <div>
        <div className="text-xs text-muted-foreground mb-1">API Base URL</div>
        <input value={apiBase} onChange={e => setApiBase(e.target.value)}
          placeholder="http://147.135.212.197/crapi/st/viewstats"
          className="w-full bg-white/[0.04] border border-white/[0.08] rounded-md px-3 py-2 text-sm font-mono" />
      </div>
      <div>
        <div className="text-xs text-muted-foreground mb-1">
          API Token {data?.has_token && <span className="text-neon-green">(currently saved — leave blank to keep)</span>}
        </div>
        <div className="relative">
          <input type={show ? "text" : "password"} value={token}
            onChange={e => setToken(e.target.value)}
            placeholder={data?.has_token ? "Leave blank to keep current" : "Paste API token from NumPanel"}
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-md px-3 py-2 text-sm font-mono pr-10" />
          <button type="button" onClick={() => setShow(s => !s)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
            {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
      </div>
      <button onClick={save} disabled={saving}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-neon-amber/10 border border-neon-amber/30 text-neon-amber hover:bg-neon-amber/20 transition disabled:opacity-50">
        <Save className={cn("w-3.5 h-3.5", saving && "animate-pulse")} />
        {saving ? "Saving…" : "Save & Restart Bot"}
      </button>
    </div>
  );
};

const AdminNumPanelStatus = () => {
  const [restarting, setRestarting] = useState(false);
  const [scraping, setScraping] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["numpanel-status"],
    queryFn: () => api.admin.numpanelStatus(),
    refetchInterval: 5000,
  });
  const { data: poolData, refetch: refetchPool } = useQuery({
    queryKey: ["numpanel-pool-breakdown"],
    queryFn: () => api.admin.numpanelPoolBreakdown(),
    refetchInterval: 10000,
  });
  const s = data?.status as NumPanelStatusT | undefined;

  const handleAction = async (action: "restart" | "start" | "stop") => {
    const labels = { restart: "Restart", start: "Start", stop: "Stop" };
    if (action === "stop" && !confirm("Stop the NumPanel bot?")) return;
    if (action === "restart" && !confirm("Restart the NumPanel bot?")) return;
    setRestarting(true);
    try {
      if (action === "restart") await api.admin.numpanelRestart();
      else if (action === "start") await api.admin.numpanelStart();
      else await api.admin.numpanelStop();
      toast.success(`${labels[action]} initiated`);
      setTimeout(() => refetch(), 1500);
    } catch (e) {
      toast.error(`${labels[action]} failed: ` + (e as Error).message);
    } finally { setRestarting(false); }
  };

  const handleScrapeNow = async () => {
    setScraping(true);
    try {
      const r = await api.admin.numpanelScrapeNow();
      if (r.ok) toast.success(`Scrape complete — ${r.otps ?? 0} OTPs delivered`);
      else toast.error(r.error || "Scrape failed");
      refetch(); refetchPool();
    } catch (e) {
      toast.error("Scrape failed: " + (e as Error).message);
    } finally { setScraping(false); }
  };

  const handleSyncLive = async () => {
    if (!confirm(
      "Live Sync will:\n" +
      "  • ADD any new MSI numbers\n" +
      "  • REMOVE pool numbers MSI no longer has\n" +
      "  • Active assigned numbers are NEVER touched\n\nContinue?"
    )) return;
    setSyncing(true);
    try {
      const r = await api.admin.numpanelSyncLive();
      if (r.ok) {
        toast.success(`Live sync done: +${r.added ?? 0} added · -${r.removed ?? 0} removed · ${r.kept ?? 0} kept (${r.scraped ?? 0} live)`, { duration: 6000 });
      } else { toast.error(r.error || "Live sync failed"); }
      refetch(); refetchPool();
    } catch (e) {
      toast.error("Live sync failed: " + (e as Error).message);
    } finally { setSyncing(false); }
  };

  return (
    <div className="relative space-y-6">
      <GradientMesh variant="default" />
      <PageHeader
        eyebrow="Workers"
        title="NumPanel Bot Status"
        description="Hybrid bot for 51.89.99.105/NumberPanel — Puppeteer login + REST CDR API (instant OTPs, no cooldown)"
        icon={<Bot className="w-5 h-5 text-neon-cyan" />}
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            {s?.running ? (
              <button onClick={() => handleAction("stop")} disabled={restarting}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-destructive/10 border border-destructive/30 text-destructive hover:bg-destructive/20 transition disabled:opacity-50">
                <Square className="w-3.5 h-3.5" /> Stop
              </button>
            ) : (
              <button onClick={() => handleAction("start")} disabled={restarting}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-neon-green/10 border border-neon-green/30 text-neon-green hover:bg-neon-green/20 transition disabled:opacity-50">
                <Play className="w-3.5 h-3.5" /> Start
              </button>
            )}
            <button onClick={handleScrapeNow} disabled={scraping || !s?.running}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-neon-cyan/10 border border-neon-cyan/30 text-neon-cyan hover:bg-neon-cyan/20 transition disabled:opacity-50">
              <Zap className={cn("w-3.5 h-3.5", scraping && "animate-pulse")} />
              {scraping ? "Scraping…" : "Scrape Now"}
            </button>
            <button onClick={handleSyncLive} disabled={syncing || !s?.running}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-neon-amber/10 border border-neon-amber/30 text-neon-amber hover:bg-neon-amber/20 transition disabled:opacity-50">
              <Sparkles className={cn("w-3.5 h-3.5", syncing && "animate-pulse")} />
              {syncing ? "Syncing…" : "Sync Live"}
            </button>
            <button onClick={() => handleAction("restart")} disabled={restarting}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-neon-magenta/10 border border-neon-magenta/30 text-neon-magenta hover:bg-neon-magenta/20 transition disabled:opacity-50">
              <Power className={cn("w-3.5 h-3.5", restarting && "animate-spin")} /> {restarting ? "Working…" : "Restart"}
            </button>
            <button onClick={() => { refetch(); refetchPool(); }}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] transition">
              <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} /> Refresh
            </button>
          </div>
        }
      />

      {isLoading && <p className="text-center text-muted-foreground text-sm">Loading…</p>}

      {s && (
        <>
          <div className="flex flex-wrap gap-2">
            <Pill ok={s.enabled} label={s.enabled ? "Enabled" : "Disabled"} />
            <Pill ok={s.running} label={s.running ? "Running" : "Stopped"} />
            <Pill ok={s.loggedIn} label={s.loggedIn ? "Logged in" : "Not logged in"} />
            <Pill ok={s.lastScrapeOk} label={s.lastScrapeOk ? "Last scrape OK" : "Last scrape failed"} />
          </div>

          <LockReveal
            title="NumPanel Login Credentials"
            subtitle="Username, password & base URL — sensitive. Click reveal to view/edit."
            accent="neon-cyan"
            icon={<Layers className="w-4 h-4 text-neon-cyan" />}
          >
            <CredentialsEditor onSaved={() => refetch()} />
          </LockReveal>

          <LockReveal
            title="NumPanel Session Cookies"
            subtitle="Saved browser session — paste once, skip captcha forever. Sensitive."
            accent="neon-purple"
            icon={<ClipboardPaste className="w-4 h-4 text-neon-purple" />}
          >
            <NumPanelCookiesEditor onSaved={() => refetch()} cookieFailStreak={s.cookieFailStreak || 0} />
          </LockReveal>

          <NumPanelOtpIntervalSetting onSaved={() => refetch()} />

          <LockReveal
            title="NumPanel CDR API Token"
            subtitle="Per-agent token from /NumberPanel/agent/API — used for instant OTP polling. Sensitive."
            accent="neon-amber"
            icon={<Zap className="w-4 h-4 text-neon-amber" />}
          >
            <NumPanelApiTokenEditor onSaved={() => refetch()} />
          </LockReveal>

          {(s.emptyLimit ?? 0) > 0 && (
            <div className="glass-card border border-white/[0.06] rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-neon-amber" /> Auto-pause guard
                </span>
                <span className="text-xs font-mono text-muted-foreground">
                  {s.emptyStreak ?? 0} / {s.emptyLimit} empty scrapes
                </span>
              </div>
              <div className="h-2 bg-white/[0.04] rounded-full overflow-hidden">
                <div
                  className={cn("h-full transition-all duration-500",
                    (s.emptyStreak ?? 0) >= (s.emptyLimit ?? 10) * 0.7 ? "bg-destructive" :
                    (s.emptyStreak ?? 0) >= (s.emptyLimit ?? 10) * 0.4 ? "bg-neon-amber" : "bg-neon-green"
                  )}
                  style={{ width: `${Math.min(100, ((s.emptyStreak ?? 0) / (s.emptyLimit ?? 10)) * 100)}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Bot will auto-stop if {s.emptyLimit} consecutive scrapes return zero numbers (set NUMPANEL_EMPTY_LIMIT env to enable; 0 = disabled).
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat icon={<CheckCircle2 className="w-3.5 h-3.5" />} label="Last login" value={fmtAgo(s.lastLoginAt)}
              hint={s.lastLoginAt ? new Date(s.lastLoginAt * 1000).toLocaleString() : "—"}
              accent="text-neon-cyan" />
            <Stat icon={<Activity className="w-3.5 h-3.5" />} label="Last scrape" value={fmtAgo(s.lastScrapeAt)}
              hint={`every ${s.otpIntervalSec}s · ${s.totalScrapes} total`}
              accent={s.lastScrapeOk ? "text-neon-green" : "text-destructive"} />
            <Stat icon={<Database className="w-3.5 h-3.5" />} label="Pool size" value={s.poolSize}
              hint={`active assigned: ${s.activeAssigned}`}
              accent="text-neon-magenta" />
            <Stat icon={<MessageSquareText className="w-3.5 h-3.5" />} label="OTPs delivered" value={s.otpsDeliveredTotal}
              hint={`${s.otpReceived} historical receipts`}
              accent="text-neon-green" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="glass-card border border-white/[0.06] rounded-xl p-5 space-y-3">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Configuration</h3>
              <div className="space-y-2 text-sm">
                <Row label="Base URL" value={s.baseUrl || "—"} mono />
                <Row label="OTP poll interval" value={`${s.otpIntervalSec}s`} mono accent="text-neon-cyan" />
                <Row label="Number sync interval" value={`${s.numbersIntervalSec}s`} mono />
                <Row label="Numbers scraped (total)" value={String(s.numbersScrapedTotal)} mono />
                <Row label="Numbers added to pool" value={String(s.numbersAddedTotal)} mono accent="text-neon-cyan" />
                <Row label="OTP cache size" value={String(s.otpCacheSize)} mono />
                <Row label="Last numbers sync" value={fmtAgo(s.lastNumbersScrapeAt)} mono />
                <Row label="Consecutive failures" value={String(s.consecFail)} mono accent={s.consecFail > 0 ? "text-destructive" : undefined} />
              </div>
            </div>

            <RangePoolGrid
              ranges={poolData?.ranges || []}
              totalActive={poolData?.totalActive || 0}
              totalUsed={poolData?.totalUsed || 0}
              onChanged={() => refetchPool()}
            />
          </div>

          {s.lastError && (
            <div className="glass-card border border-destructive/30 bg-destructive/5 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-1">
                <XCircle className="w-4 h-4 text-destructive" />
                <span className="text-xs font-semibold uppercase tracking-wider text-destructive">Last Error</span>
                <span className="text-xs text-muted-foreground">{fmtAgo(s.lastErrorAt)}</span>
              </div>
              <p className="text-sm font-mono text-destructive/90">{s.lastError}</p>
            </div>
          )}

          <div className="glass-card border border-white/[0.06] rounded-xl p-5">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">Recent Activity</h3>
            {s.events?.length ? (
              <div className="space-y-1.5 max-h-80 overflow-y-auto scrollbar-none">
                {s.events.map((e, i) => (
                  <div key={i} className="flex items-start gap-3 text-xs py-1.5 border-b border-white/[0.04]">
                    <span className="font-mono text-muted-foreground whitespace-nowrap">{fmtAgo(e.ts)}</span>
                    <span className={cn("font-semibold uppercase",
                      e.level === "success" && "text-neon-green",
                      e.level === "error" && "text-destructive",
                      e.level === "warn" && "text-neon-amber",
                      e.level === "info" && "text-neon-cyan",
                    )}>{e.level}</span>
                    <span className="text-foreground/80 flex-1">{e.message}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic">No events yet</p>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default AdminNumPanelStatus;

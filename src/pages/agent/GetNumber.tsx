import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { GlassCard } from "@/components/GlassCard";
import { Button } from "@/components/ui/button";
import { Hash, Copy, Check, Download, Search, ChevronDown, Wallet, AlertTriangle, Layers, Server, ChevronLeft, ChevronRight, Bell, BellOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";

interface AllocatedNumber {
  id: number;
  phone_number: string;
  operator?: string | null;
  otp: string | null;
  status: "active" | "received" | "expired";
  allocated_at?: number;       // unix seconds
  otp_received_at?: number | null;
}

interface Country {
  id: number;
  name: string;
  code?: string;
  flag?: string;
  price_bdt?: number;
}

interface Operator {
  id: number;
  name: string;
  price_bdt?: number;
}

interface Range {
  name: string;
  count: number;
}

// Agents see "Server A/B/C/D" — real provider names (acchub/ims/msi/numpanel) are hidden.
// The actual list shown is filtered against the backend `/numbers/providers` response,
// so disabled bots disappear from the picker entirely (no dead options for agents).
export const SERVER_LABELS: Record<string, string> = {
  acchub: "Server A",
  ims: "Server B",
  msi: "Server C",
  numpanel: "Server D",
  iprn: "Server E",
  iprn_sms: "Server F",
  all: "All Servers",
};
type ServerId = "acchub" | "ims" | "msi" | "numpanel" | "iprn" | "iprn_sms" | "all";

// Unified-pool entry from /numbers/all/ranges. `name` is already the
// "Country — Range (Server X)" label so we render it as-is.
interface AllRange {
  key: string;          // <providerId>::<rangeName>
  name: string;         // display label
  range: string;
  provider: string;
  provider_label: string;
  country_code: string | null;
  country_name?: string | null;
  count: number;
}

const AgentGetNumber = () => {
  const { user, maintenanceMode, maintenanceMessage } = useAuth();
  // Agents use the unified pool exclusively (Country → Range, no Server tabs).
  // Admins still see the legacy Server picker so they can use AccHub + audit
  // which underlying bot a range belongs to.
  const isAdmin = user?.role === "admin";
  const [provider, setProvider] = useState<ServerId>(isAdmin ? "acchub" : "all");
  // Servers that the BACKEND currently has enabled (filtered by /numbers/providers).
  // Disabled bots simply disappear from the picker so agents never see dead options.
  const [availableServers, setAvailableServers] = useState<{ id: ServerId; label: string }[]>([
    { id: "acchub", label: SERVER_LABELS.acchub },
  ]);
  // True once /numbers/providers has resolved at least once. Lets us
  // distinguish "still loading" from "backend returned zero enabled
  // providers" so the empty-state banner only shows in the latter case.
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [countries, setCountries] = useState<Country[]>([]);
  const [countryId, setCountryId] = useState<number | "">("");
  const [operators, setOperators] = useState<Operator[]>([]);
  const [operatorId, setOperatorId] = useState<number | "">("");
  const [ranges, setRanges] = useState<Range[]>([]);
  // Unified-pool ranges (only used when provider === 'all')
  const [allRanges, setAllRanges] = useState<AllRange[]>([]);
  const [rangeName, setRangeName] = useState<string>("");
  const [rangeSearch, setRangeSearch] = useState("");
  const [rangeOpen, setRangeOpen] = useState(false);
  const rangeRef = useRef<HTMLDivElement>(null);
  const [numbers, setNumbers] = useState<AllocatedNumber[]>([]);
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [copiedOtpId, setCopiedOtpId] = useState<number | null>(null);
  // IDs of allocations whose OTP just arrived in the latest poll —
  // used to flash a green highlight + ring on the row so the agent
  // visually spots WHICH number got an OTP without scanning the whole list.
  const [flashOtpIds, setFlashOtpIds] = useState<Set<number>>(new Set());
  const [quantity, setQuantity] = useState(1);
  const [page, setPage] = useState(1);
  const [serverDriftSec, setServerDriftSec] = useState(0);
  const [nowTick, setNowTick] = useState(() => Math.floor(Date.now() / 1000));
  const [expirySec, setExpirySec] = useState<number>(1800); // fallback 30 min
  // Auto-release expired toggle — persisted in localStorage so it survives
  // reload. When ON, any number expired for >60s is released automatically.
  const [autoRelease, setAutoRelease] = useState<boolean>(
    () => localStorage.getItem("nx_auto_release") === "1"
  );
  useEffect(() => {
    localStorage.setItem("nx_auto_release", autoRelease ? "1" : "0");
  }, [autoRelease]);
  // "Don't ask again" preference for the All-Servers confirmation prompt.
  // Persisted in localStorage so the agent's choice survives reloads.
  const [skipAllConfirm, setSkipAllConfirm] = useState<boolean>(
    () => localStorage.getItem("nx_skip_all_confirm") === "1"
  );
  useEffect(() => {
    localStorage.setItem("nx_skip_all_confirm", skipAllConfirm ? "1" : "0");
  }, [skipAllConfirm]);
  // Sticky Country + Range selection for agent unified-pool flow.
  // We persist the country code (e.g. "TJ") and the full range KEY
  // ("iprn_sms::99293515XXXX(1)") so the choice survives reloads — exactly
  // what the user asked for: "stick country and ranges until they change".
  const [allCountry, setAllCountry] = useState<string>(
    () => localStorage.getItem("nx_all_country") || ""
  );
  useEffect(() => {
    if (allCountry) localStorage.setItem("nx_all_country", allCountry);
    else localStorage.removeItem("nx_all_country");
  }, [allCountry]);
  // Country combobox state (separate from the legacy AccHub country picker)
  const [allCountryOpen, setAllCountryOpen] = useState(false);
  const [allCountrySearch, setAllCountrySearch] = useState("");
  const allCountryRef = useRef<HTMLDivElement>(null);
  // Browser desktop notification permission state
  const [notifPerm, setNotifPerm] = useState<NotificationPermission>(
    () => (typeof Notification !== "undefined" ? Notification.permission : "denied")
  );
  // Track IDs we've already auto-released so we don't loop on stale rows.
  const autoReleasedIds = useRef<Set<number>>(new Set());
  const PAGE_SIZE = 25;
  const serverNowSec = nowTick - serverDriftSec;

  // Web Audio beep — no asset needed. Two short ascending tones (660→880 Hz)
  // play when a fresh OTP lands. Catches the agent's attention in another tab.
  const playBeep = () => {
    try {
      const AC = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
      if (!AC) return;
      const ctx = new AC();
      const tone = (freq: number, start: number, dur: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
        gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + start);
        osc.stop(ctx.currentTime + start + dur + 0.02);
      };
      tone(660, 0, 0.18);
      tone(880, 0.18, 0.22);
      setTimeout(() => ctx.close().catch(() => {}), 800);
    } catch { /* sound is best-effort */ }
  };

  // Desktop notification — only fires when tab is hidden (when visible,
  // toast + green row flash is already obvious).
  const showDesktopNotif = (title: string, body: string) => {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    if (document.visibilityState === "visible") return;
    try {
      const n = new Notification(title, { body, tag: "nexus-otp", icon: "/favicon.ico" });
      n.onclick = () => { window.focus(); n.close(); };
      setTimeout(() => n.close(), 8000);
    } catch { /* ignore */ }
  };

  const requestNotifPermission = () => {
    if (typeof Notification === "undefined") {
      toast({ title: "Notifications not supported in this browser", variant: "destructive" });
      return;
    }
    Notification.requestPermission()
      .then((p) => {
        setNotifPerm(p);
        toast({
          title: p === "granted" ? "Desktop notifications enabled" : "Notifications blocked",
          description: p === "granted" ? "You'll get a popup when OTP arrives even if tab is hidden" : "Enable in browser site settings to receive popups",
          variant: p === "granted" ? "default" : "destructive",
        });
      })
      .catch(() => {});
  };

  // Tick once per second so elapsed-time column re-renders live
  useEffect(() => {
    const i = setInterval(() => setNowTick(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(i);
  }, []);

  // Fetch shared expiry config + server time once on mount so the website UI
  // matches backend/TG logic and is immune to browser clock drift.
  useEffect(() => {
    api.numbersConfig()
      .then(({ otp_expiry_sec, server_now }) => {
        if (otp_expiry_sec > 0) setExpirySec(otp_expiry_sec);
        if (server_now > 0) setServerDriftSec(Math.floor(Date.now() / 1000) - server_now);
      })
      .catch(() => {/* keep fallback */});
  }, []);

  // Pull the list of enabled providers from the backend so disabled bots are
  // hidden from the Source picker entirely. Refreshed on mount, on tab
  // focus, every 30s, and right before each allocation — so a mid-session
  // admin toggle is reflected without the agent needing to reload.
  const refreshProviders = useCallback(async () => {
    try {
      const { providers } = await api.providers();
      const list = (providers || [])
        .map((p) => ({ id: p.id as ServerId, label: SERVER_LABELS[p.id] || p.name || p.id }))
        .filter((s) => SERVER_LABELS[s.id]);
      setAvailableServers(list);
      // Auto-switch if the current selection just got disabled.
      setProvider((cur) => (list.length > 0 && !list.some((s) => s.id === cur) ? list[0].id : cur));
      return list;
    } catch {
      return null;
    } finally {
      setProvidersLoaded(true);
    }
  }, []);

  useEffect(() => {
    refreshProviders();
    const onFocus = () => refreshProviders();
    const onVis = () => { if (document.visibilityState === "visible") refreshProviders(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    const i = setInterval(refreshProviders, 30000);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(i);
    };
  }, [refreshProviders]);

  // Format a duration in seconds: "12s" / "1m 04s" / "1h 02m"
  const fmtDuration = (sec: number) => {
    const s = Math.max(0, Math.floor(sec));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
    return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  };

  // Country search dropdown
  const [countryOpen, setCountryOpen] = useState(false);
  const [countrySearch, setCountrySearch] = useState("");
  const countryRef = useRef<HTMLDivElement>(null);

  const maxPerRequest = user?.per_request_limit ?? 15;
  const dailyLimit = user?.daily_limit ?? 100;
  const usedToday = numbers.length;

  const selectedCountry = countries.find((c) => c.id === countryId);
  const selectedOperator = operators.find((o) => o.id === operatorId);
  const cost = selectedOperator?.price_bdt ?? selectedCountry?.price_bdt ?? null;
  const totalCost = cost != null ? cost * quantity : null;

  // Quantity options capped to per-request limit (always include maxPerRequest as the top option)
  const quantityOptions = Array.from(
    new Set(
      [1, 5, 10, 25, 50, 100, maxPerRequest]
        .filter((q) => q > 0 && q <= maxPerRequest)
        .sort((a, b) => a - b),
    ),
  );

  useEffect(() => {
    api.myNumbers().then(({ numbers }) => setNumbers(numbers as AllocatedNumber[])).catch(() => {});
  }, []);

  // Reload countries OR ranges whenever the agent switches Server A / B
  useEffect(() => {
    setCountryId("");
    setOperatorId("");
    setOperators([]);
    setRangeName("");
    if (provider === "ims") {
      api.imsRanges().then(({ ranges }) => setRanges(ranges)).catch(() => setRanges([]));
      setCountries([]);
    } else if (provider === "msi") {
      api.msiRanges().then(({ ranges }) => setRanges(ranges)).catch(() => setRanges([]));
      setCountries([]);
    } else if (provider === "all") {
      api.allRanges().then(({ ranges }) => {
        setAllRanges(ranges);
        // Also feed the shared `ranges` state (using key as name) so the
        // existing dropdown UI can render without branching everywhere.
        setRanges(ranges.map((r) => ({ name: r.key, count: r.count })));
      }).catch(() => { setAllRanges([]); setRanges([]); });
      setCountries([]);
    } else {
      setRanges([]);
      setAllRanges([]);
      api.countries(provider).then(({ countries }) => setCountries(countries)).catch(() => setCountries([]));
    }
  }, [provider]);

  // Refresh range counts every 10s while a range-based server is selected
  useEffect(() => {
    if (provider !== "ims" && provider !== "msi" && provider !== "all") return;
    const fetcher = provider === "ims" ? api.imsRanges
                   : provider === "msi" ? api.msiRanges
                   : async () => {
                       const { ranges } = await api.allRanges();
                       setAllRanges(ranges);
                       return { ranges: ranges.map((r) => ({ name: r.key, count: r.count })) };
                     };
    const i = setInterval(() => {
      fetcher().then(({ ranges }) => setRanges(ranges)).catch(() => {});
    }, 10000);
    return () => clearInterval(i);
  }, [provider]);

  useEffect(() => {
    if (provider === "ims" || provider === "msi" || provider === "all" || !countryId) { setOperators([]); setOperatorId(""); return; }
    setOperatorId("");
    api.operators(provider, Number(countryId)).then(({ operators }) => setOperators(operators)).catch(() => {});
  }, [countryId, provider]);

  // Close country/range dropdowns on outside click
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (countryRef.current && !countryRef.current.contains(e.target as Node)) setCountryOpen(false);
      if (rangeRef.current && !rangeRef.current.contains(e.target as Node)) setRangeOpen(false);
      if (allCountryRef.current && !allCountryRef.current.contains(e.target as Node)) setAllCountryOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const filteredCountries = useMemo(() => {
    const q = countrySearch.trim().toLowerCase();
    if (!q) return countries;
    return countries.filter((c) =>
      c.name.toLowerCase().includes(q) || (c.code || "").includes(q)
    );
  }, [countries, countrySearch]);

  const filteredRanges = useMemo(() => {
    const q = rangeSearch.trim().toLowerCase();
    // For unified pool, match against the friendly label (country/provider/range), not the key.
    const labelOf = (key: string) => {
      if (provider !== "all") return key;
      const m = allRanges.find((x) => x.key === key);
      return m ? m.name : key;
    };
    // For agents in unified-pool mode, also restrict to the chosen country.
    let pool = ranges;
    if (provider === "all" && allCountry) {
      const allowedKeys = new Set(
        allRanges.filter((r) => (r.country_code || "") === allCountry).map((r) => r.key)
      );
      pool = pool.filter((r) => allowedKeys.has(r.name));
    }
    if (!q) return pool;
    return pool.filter((r) => labelOf(r.name).toLowerCase().includes(q));
  }, [ranges, rangeSearch, provider, allRanges, allCountry]);

  // Country list derived from the unified pool (for agent Country dropdown).
  // Each entry shows the country name (or ISO code) + total ranges/numbers
  // available across all underlying bots — gives the agent an at-a-glance
  // sense of which countries actually have stock right now.
  const allCountryList = useMemo(() => {
    const map = new Map<string, { code: string; name: string; ranges: number; count: number }>();
    for (const r of allRanges) {
      const code = r.country_code || "ZZ";
      const name = r.country_name || code;
      const ex = map.get(code) || { code, name, ranges: 0, count: 0 };
      ex.ranges += 1;
      ex.count += r.count;
      map.set(code, ex);
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [allRanges]);

  const filteredAllCountries = useMemo(() => {
    const q = allCountrySearch.trim().toLowerCase();
    if (!q) return allCountryList;
    return allCountryList.filter((c) =>
      c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q)
    );
  }, [allCountryList, allCountrySearch]);

  const selectedAllCountry = allCountryList.find((c) => c.code === allCountry);

  const selectedRange = ranges.find((r) => r.name === rangeName);
  // Friendly label resolver. For the unified "All Servers" pool:
  //   • Admins see the full backend label, e.g. "TJ — Tajikistan 99293515XXXX (Server F)"
  //     so they can audit which underlying bot a range belongs to.
  //   • Agents see ONLY country + range, e.g. "TJ — Tajikistan 99293515XXXX",
  //     because the underlying provider is internal info they don't need.
  const labelForRange = (key: string): string => {
    if (provider !== "all") return key;
    const m = allRanges.find((x) => x.key === key);
    if (!m) return key;
    if (isAdmin) return m.name;
    // Strip the trailing "(Server X)" tag for non-admins
    return m.name.replace(/\s*\(Server [A-Z]\)\s*$/i, "").trim();
  };
  // Provider tag shown next to the count badge — admin-only, so the
  // dropdown stays consistent: "<count> avail · Server X" for admins,
  // just "<count> avail" for agents.
  const providerTagForRange = (key: string): string | null => {
    if (provider !== "all" || !isAdmin) return null;
    const m = allRanges.find((x) => x.key === key);
    return m?.provider_label || null;
  };
  const totalPoolSize = ranges.reduce((sum, r) => sum + r.count, 0);

  const handleGetNumber = async () => {
    if (maintenanceMode) {
      toast({ title: "Maintenance mode", description: maintenanceMessage, variant: "destructive" });
      return;
    }
    // Confirmation prompt for the unified "All Servers" pool — agents
    // sometimes pick it by accident thinking it's a single bot. We make it
    // explicit that the chosen range belongs to a SPECIFIC underlying
    // provider and ask them to confirm before billing kicks in. Skipped
    // when the agent ticks "don't ask again" (persisted in localStorage).
    if (provider === "all" && rangeName) {
      if (!skipAllConfirm) {
        const meta = allRanges.find((x) => x.key === rangeName);
        // Same admin-vs-agent rule as the dropdown: only admins see "Server X".
        const friendly = meta
          ? (isAdmin ? meta.name : meta.name.replace(/\s*\(Server [A-Z]\)\s*$/i, "").trim())
          : rangeName;
        const target = meta ? `${friendly} — ${meta.count} available` : friendly;
        const serverLine = isAdmin && meta?.provider_label
          ? `\n\nThis range belongs to ${meta.provider_label}.`
          : "";
        const msg =
          `You are about to allocate ${quantity} number${quantity > 1 ? "s" : ""} ` +
          `from:\n\n${target}${serverLine}\n\n` +
          `Continue?\n\n(Tip: tick OK to proceed. Cancel to pick a different range.)`;
        const ok = window.confirm(msg);
        if (!ok) return;
      }
    }
    // Re-check enabled providers RIGHT before allocating so the agent
    // never sends a request to a provider that just got disabled.
    const fresh = await refreshProviders();
    if (fresh && !fresh.some((s) => s.id === provider)) {
      toast({
        title: "Source disabled by admin",
        description: fresh.length > 0
          ? `Switched to ${fresh[0].label}. Try again.`
          : "All providers are off right now.",
        variant: "destructive",
      });
      return;
    }
    if (provider === "ims" || provider === "msi" || provider === "all") {
      if (!rangeName) { toast({ title: "Select a range", variant: "destructive" }); return; }
    } else if (!countryId || !operatorId) {
      toast({ title: "Select country & operator", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      const { allocated, errors } = await api.getNumber({
        provider,
        ...(provider === "ims" || provider === "msi" || provider === "all"
          ? { range: rangeName }
          : { country_id: Number(countryId), operator_id: Number(operatorId) }),
        count: quantity,
      });
      const nowSec = serverNowSec;
      setNumbers((prev) => [...allocated.map((a: AllocatedNumber) => ({ ...a, status: "active" as const, allocated_at: a.allocated_at ?? nowSec })), ...prev]);
      setPage(1);
      if (allocated.length) {
        try {
          const clip = allocated.map((a: AllocatedNumber) => a.phone_number).join("\n");
          await navigator.clipboard.writeText(clip);
          toast({
            title: `${allocated.length} number${allocated.length > 1 ? "s" : ""} allocated & copied!`,
            description: allocated.length === 1 ? allocated[0].phone_number : `${allocated.length} numbers copied to clipboard`,
          });
        } catch {
          toast({ title: `${allocated.length} number${allocated.length > 1 ? "s" : ""} allocated!`, description: allocated[0].phone_number });
        }
      }
      if (errors.length) toast({ title: "Some failed", description: errors.join(", "), variant: "destructive" });
      if (provider === "ims") api.imsRanges().then(({ ranges }) => setRanges(ranges)).catch(() => {});
      else if (provider === "msi") api.msiRanges().then(({ ranges }) => setRanges(ranges)).catch(() => {});
      else if (provider === "all") api.allRanges().then(({ ranges }) => {
        setAllRanges(ranges);
        setRanges(ranges.map((r) => ({ name: r.key, count: r.count })));
      }).catch(() => {});
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Dedicated state for the soft-OFF case. Backend returns
      // { status: 403, code: 'PROVIDER_DISABLED' } so we switch on the
      // machine code, never the human-readable text.
      const isDisabled =
        e instanceof ApiError && (e.code === "PROVIDER_DISABLED" || e.status === 403);
      if (isDisabled) {
        const after = await refreshProviders();
        toast({
          title: "Provider disabled mid-session",
          description: after && after.length > 0
            ? `${msg} Switched to ${after[0].label}.`
            : msg,
          variant: "destructive",
        });
      } else {
        toast({ title: "Failed", description: msg, variant: "destructive" });
      }
    } finally {
      setLoading(false);
    }
  };

  // Poll OTP sync every 5s while there are pending numbers.
  // When a poll reveals NEW OTPs (numbers that previously had no OTP but now do),
  // we flash their rows green for 8s + toast which number got it. This makes it
  // dead-obvious which row in a 100-number list just received its code.
  useEffect(() => {
    const pending = numbers.filter((n) => !n.otp).length;
    if (pending === 0) return;
    const interval = setInterval(async () => {
      try {
        await api.syncOtp();
        const { numbers: fresh, otp_expiry_sec, server_now } = await api.myNumbers();
        const freshList = fresh as AllocatedNumber[];
        if (otp_expiry_sec && otp_expiry_sec > 0) setExpirySec(otp_expiry_sec);
        if (server_now && server_now > 0) setServerDriftSec(Math.floor(Date.now() / 1000) - server_now);
        // Diff: which previously-pending IDs now have an OTP?
        const prevPendingIds = new Set(numbers.filter((n) => !n.otp).map((n) => n.id));
        const newlyReceived = freshList.filter((n) => n.otp && prevPendingIds.has(n.id));
        if (newlyReceived.length > 0) {
          setFlashOtpIds((prev) => {
            const next = new Set(prev);
            newlyReceived.forEach((n) => next.add(n.id));
            return next;
          });
          // Auto-clear flash after 8s so the highlight is temporary
          setTimeout(() => {
            setFlashOtpIds((prev) => {
              const next = new Set(prev);
              newlyReceived.forEach((n) => next.delete(n.id));
              return next;
            });
          }, 8000);
          // Sound alert (single beep for the whole batch)
          playBeep();
          // Toast + desktop notif — show which number(s) got OTP
          newlyReceived.slice(0, 3).forEach((n) => {
            toast({
              title: `OTP received: ${n.phone_number}`,
              description: `Code: ${n.otp}`,
            });
          });
          // Desktop popup (only fires if tab hidden)
          const first = newlyReceived[0];
          const more = newlyReceived.length > 1 ? ` (+${newlyReceived.length - 1} more)` : "";
          showDesktopNotif(
            `OTP received${more}`,
            `${first.phone_number} → ${first.otp}`
          );
        }
        setNumbers(freshList);
      } catch { /* ignore */ }
    }, 5000);
    return () => clearInterval(interval);
  }, [numbers]);

  // Auto-release expired numbers — runs every 15s while toggle is ON.
  // Releases anything that has been expired for >60s (grace period in case
  // OTP arrives late). Each ID released only once per session.
  useEffect(() => {
    if (!autoRelease) return;
    const sweep = async () => {
        const nowS = serverNowSec;
        const toRelease = numbers.filter((n) => {
          if (n.otp) return false;
          if (autoReleasedIds.current.has(n.id)) return false;
          const allocAt = n.allocated_at || nowS;
          const expiredFor = nowS - allocAt - expirySec;
          return expiredFor >= 60; // 60s grace
        });
      if (toRelease.length === 0) return;
      const releasedIds: number[] = [];
      for (const n of toRelease) {
        autoReleasedIds.current.add(n.id);
        try {
          await api.releaseNumber(n.id);
          releasedIds.push(n.id);
        } catch { /* ignore individual failures */ }
      }
      if (releasedIds.length > 0) {
        setNumbers((prev) => prev.filter((x) => !releasedIds.includes(x.id)));
        toast({
          title: `Auto-released ${releasedIds.length} expired number${releasedIds.length > 1 ? "s" : ""}`,
          description: "Toggle off if you want to keep expired numbers visible",
        });
      }
    };
    const i = setInterval(sweep, 15000);
    sweep(); // run once immediately on toggle-on
    return () => clearInterval(i);
  }, [autoRelease, numbers, expirySec]);

  const copyItem = (id: number, text: string, type: "num" | "otp") => {
    navigator.clipboard.writeText(text);
    if (type === "num") { setCopiedId(id); setTimeout(() => setCopiedId(null), 1500); }
    else { setCopiedOtpId(id); setTimeout(() => setCopiedOtpId(null), 1500); }
  };

  const copyAll = () => {
    const all = numbers.map(n => n.otp ? `${n.phone_number}|${n.otp}` : n.phone_number).join("\n");
    navigator.clipboard.writeText(all);
    toast({ title: "Copied!", description: `${numbers.length} entries copied` });
  };

  const downloadTxt = () => {
    const content = numbers.map(n => n.otp ? `${n.phone_number}|${n.otp}` : n.phone_number).join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nexusx-numbers-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Downloaded!", description: `${numbers.length} entries saved as Number|OTP format` });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-bold text-foreground">Get Number</h1>
        <p className="text-sm text-muted-foreground mt-1">Search a country, pick an operator, and request a fresh number</p>
      </div>

      {maintenanceMode && (
        <GlassCard className="border-neon-amber/40 bg-neon-amber/[0.06]">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-6 h-6 text-neon-amber shrink-0 mt-0.5" />
            <div>
              <h3 className="font-display font-semibold text-neon-amber">Maintenance Mode Active</h3>
              <p className="text-sm text-muted-foreground mt-1">{maintenanceMessage}</p>
              <p className="text-xs text-muted-foreground mt-2">Number allocation is temporarily disabled. Please check back soon.</p>
            </div>
          </div>
        </GlassCard>
      )}

      {/* All providers OFF — admin has soft-disabled every bot. We show
          this banner so the agent knows WHY the Source picker is empty
          (instead of silently rendering a useless form). */}
      {providersLoaded && availableServers.length === 0 && !maintenanceMode && (
        <GlassCard className="border-destructive/40 bg-destructive/[0.06]">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-6 h-6 text-destructive shrink-0 mt-0.5" />
            <div>
              <h3 className="font-display font-semibold text-destructive">All providers are temporarily disabled</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Admin has switched off every number source. New allocations are paused until at least one provider is re-enabled.
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                Existing numbers in your live list will continue to receive OTPs normally.
              </p>
            </div>
          </div>
        </GlassCard>
      )}

      {availableServers.length > 0 && (
      <GlassCard glow="cyan" className={cn("relative", (countryOpen || rangeOpen) ? "z-50" : "z-10")}>
        {/* Server selector — Server A = AccHub, Server B = IMS (real names hidden) */}
        <div className="flex items-center gap-2 mb-4 pb-4 border-b border-white/[0.06]">
          <Server className="w-4 h-4 text-neon-cyan" />
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mr-2">Source</span>
          <div className="flex gap-2">
            {availableServers.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setProvider(s.id)}
                className={cn(
                  "px-4 h-9 rounded-lg text-xs font-bold transition-all border",
                  provider === s.id
                    ? "bg-gradient-to-r from-primary to-neon-magenta text-primary-foreground border-transparent shadow-[0_0_18px_-4px_hsl(var(--primary)/0.6)]"
                    : "bg-white/[0.03] text-foreground border-white/[0.08] hover:bg-white/[0.08] hover:border-white/[0.16]",
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {provider === "all" && (
          /* Unified-pool warning + "don't ask again" toggle. We surface this
             prominently because each range in this list belongs to ONE
             specific underlying bot — the agent should know exactly which
             before allocating (the dropdown labels show "Server X" too). */
          <div className="mb-4 px-3 py-2.5 rounded-lg border border-neon-cyan/25 bg-neon-cyan/[0.05] flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-neon-cyan shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-foreground">
                <span className="font-semibold">All Servers mode:</span>{" "}
                <span className="text-muted-foreground">
                  Pick a country and range — we'll fetch a fresh number from the
                  matching pool. You'll be asked to confirm before every
                  allocation so a wrong pick doesn't burn balance.
                </span>
              </p>
              <label className="mt-1.5 inline-flex items-center gap-2 text-[11px] text-muted-foreground cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={skipAllConfirm}
                  onChange={(e) => setSkipAllConfirm(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-white/20 bg-white/[0.04] accent-neon-cyan"
                />
                <span>Don't ask again on this device</span>
              </label>
            </div>
          </div>
        )}

        {provider === "ims" || provider === "msi" || provider === "all" ? (
          /* ============ Server B/C (range-based): single Range dropdown ============ */
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-4 items-end">
            <div className="space-y-2 relative" ref={rangeRef}>
              <label className="text-sm font-medium text-muted-foreground flex items-center justify-between">
                <span>Range</span>
                <span className="text-[10px] text-muted-foreground/70 font-normal">
                  {ranges.length} ranges · <span className="text-neon-green font-semibold">{totalPoolSize}</span> numbers in pool
                </span>
              </label>
              <button
                type="button"
                onClick={() => setRangeOpen((v) => !v)}
                className="w-full h-11 rounded-lg bg-white/[0.04] border border-white/[0.1] px-3 text-sm text-foreground focus:outline-none focus:border-primary/50 flex items-center justify-between gap-2"
              >
                <span className={cn("truncate", !selectedRange && "text-muted-foreground")}>
                  {selectedRange ? (
                    <>
                      {labelForRange(selectedRange.name)}
                      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-neon-green/15 text-neon-green font-semibold">
                        {selectedRange.count} avail{providerTagForRange(selectedRange.name) ? ` · ${providerTagForRange(selectedRange.name)}` : ""}
                      </span>
                    </>
                  ) : ranges.length === 0 ? "No ranges available — wait for refill" : "Select a range..."}
                </span>
                <ChevronDown className={cn("w-4 h-4 text-muted-foreground transition-transform shrink-0", rangeOpen && "rotate-180")} />
              </button>

              {rangeOpen && (
                <div className="absolute z-[200] mt-1 w-full rounded-lg bg-[hsl(var(--card))] border border-white/[0.12] shadow-2xl overflow-hidden">
                  <div className="p-2 border-b border-white/[0.06] sticky top-0 bg-[hsl(var(--card))]">
                    <div className="relative">
                      <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <input
                        autoFocus
                        value={rangeSearch}
                        onChange={(e) => setRangeSearch(e.target.value)}
                        placeholder="Search range (Peru, Bitel, TF04...)"
                        className="w-full h-9 pl-9 pr-3 rounded-md bg-white/[0.04] border border-white/[0.08] text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
                      />
                    </div>
                  </div>
                  <div className="max-h-72 overflow-y-auto scrollbar-none bg-[hsl(var(--card))]">
                    {filteredRanges.length === 0 ? (
                      <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                        {ranges.length === 0 ? "Pool is empty — admin needs to refill" : `No ranges match "${rangeSearch}"`}
                      </div>
                    ) : (
                      filteredRanges.map((r) => (
                        <button
                          key={r.name}
                          onClick={() => { setRangeName(r.name); setRangeOpen(false); setRangeSearch(""); }}
                          className={cn(
                            "w-full px-3 py-2.5 text-left text-sm flex items-center justify-between gap-2 hover:bg-white/[0.06] transition-colors",
                            rangeName === r.name && "bg-primary/10 text-primary"
                          )}
                        >
                          <span className="truncate">{labelForRange(r.name)}</span>
                          <span className="flex items-center gap-1.5 shrink-0">
                            {providerTagForRange(r.name) && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] text-muted-foreground font-mono">
                                {providerTagForRange(r.name)}
                              </span>
                            )}
                            <span className={cn(
                              "text-[10px] px-1.5 py-0.5 rounded font-mono font-semibold",
                              r.count > 50 ? "bg-neon-green/15 text-neon-green" :
                              r.count > 10 ? "bg-neon-amber/15 text-neon-amber" :
                              "bg-destructive/15 text-destructive"
                            )}>
                              {r.count} avail
                            </span>
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>

            <Button
              onClick={handleGetNumber}
              disabled={loading || maintenanceMode || usedToday >= dailyLimit || !rangeName}
              className="h-11 bg-gradient-to-r from-primary to-neon-magenta text-primary-foreground font-semibold hover:opacity-90 border-0 min-w-[180px]"
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
              ) : (
                <>
                  <Hash className="w-4 h-4 mr-2" />
                  Get {quantity > 1 ? `${quantity} Numbers` : "Number"}
                </>
              )}
            </Button>
          </div>
        ) : (
          /* ============ Server A (AccHub): Country + Operator ============ */
          <div className="grid grid-cols-1 sm:grid-cols-[1.4fr_1fr_auto] gap-4 items-end">
            {/* Country searchable combobox */}
            <div className="space-y-2 relative" ref={countryRef}>
              <label className="text-sm font-medium text-muted-foreground">Country</label>
              <button
                type="button"
                onClick={() => setCountryOpen((v) => !v)}
                className="w-full h-11 rounded-lg bg-white/[0.04] border border-white/[0.1] px-3 text-sm text-foreground focus:outline-none focus:border-primary/50 flex items-center justify-between gap-2"
              >
                <span className={cn("truncate", !selectedCountry && "text-muted-foreground")}>
                  {selectedCountry ? selectedCountry.name : "Select country..."}
                </span>
                <ChevronDown className={cn("w-4 h-4 text-muted-foreground transition-transform shrink-0", countryOpen && "rotate-180")} />
              </button>

              {countryOpen && (
                <div className="absolute z-[200] mt-1 w-full rounded-lg bg-[hsl(var(--card))] border border-white/[0.12] shadow-2xl overflow-hidden">
                  <div className="p-2 border-b border-white/[0.06] sticky top-0 bg-[hsl(var(--card))]">
                    <div className="relative">
                      <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <input
                        autoFocus
                        value={countrySearch}
                        onChange={(e) => setCountrySearch(e.target.value)}
                        placeholder="Search country or code (+91, +234...)"
                        className="w-full h-9 pl-9 pr-3 rounded-md bg-white/[0.04] border border-white/[0.08] text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
                      />
                    </div>
                  </div>
                  <div className="max-h-72 overflow-y-auto scrollbar-none bg-[hsl(var(--card))]">
                    {filteredCountries.length === 0 ? (
                      <div className="px-3 py-6 text-center text-xs text-muted-foreground">No countries match "{countrySearch}"</div>
                    ) : (
                      filteredCountries.map((c) => (
                        <button
                          key={c.id}
                          onClick={() => { setCountryId(c.id); setCountryOpen(false); setCountrySearch(""); }}
                          className={cn(
                            "w-full px-3 py-2.5 text-left text-sm flex items-center gap-2 hover:bg-white/[0.06] transition-colors",
                            countryId === c.id && "bg-primary/10 text-primary"
                          )}
                        >
                          <span className="truncate">{c.name}</span>
                        </button>
                      ))
                    )}
                  </div>
                  <div className="px-3 py-2 text-[10px] text-muted-foreground border-t border-white/[0.06] bg-[hsl(var(--card))]">
                    {filteredCountries.length} of {countries.length} countries
                  </div>
                </div>
              )}
            </div>

            {/* Operator */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-muted-foreground">Operator</label>
              <select
                value={operatorId}
                onChange={(e) => setOperatorId(e.target.value ? Number(e.target.value) : "")}
                disabled={!countryId}
                className="w-full h-11 rounded-lg bg-white/[0.04] border border-white/[0.1] px-3 text-sm text-foreground focus:outline-none focus:border-primary/50 disabled:opacity-50"
              >
                <option value="" className="bg-card">Select operator</option>
                {operators.map((o) => (
                  <option key={o.id} value={o.id} className="bg-card">{o.name}</option>
                ))}
              </select>
            </div>

            <Button
              onClick={handleGetNumber}
              disabled={loading || maintenanceMode || usedToday >= dailyLimit || !operatorId}
              className="h-11 bg-gradient-to-r from-primary to-neon-magenta text-primary-foreground font-semibold hover:opacity-90 border-0 min-w-[180px]"
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
              ) : (
                <>
                  <Hash className="w-4 h-4 mr-2" />
                  Get {quantity > 1 ? `${quantity} Numbers` : "Number"}
                </>
              )}
            </Button>
          </div>
        )}

        {/* Bulk quantity selector */}
        {quantityOptions.length > 1 && (
          <div className="flex items-center justify-between gap-3 mt-4 pt-4 border-t border-white/[0.06] flex-wrap">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-neon-cyan" />
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Bulk request</span>
            </div>
            <div className="flex gap-2">
              {quantityOptions.map((q) => (
                <button
                  key={q}
                  onClick={() => setQuantity(q)}
                  disabled={maintenanceMode}
                  className={cn(
                    "min-w-[56px] h-9 px-4 rounded-lg text-xs font-bold transition-all border",
                    quantity === q
                      ? "bg-gradient-to-r from-primary to-neon-magenta text-primary-foreground border-transparent shadow-[0_0_18px_-4px_hsl(var(--primary)/0.6)]"
                      : "bg-white/[0.03] text-foreground border-white/[0.08] hover:bg-white/[0.08] hover:border-white/[0.16]",
                    maintenanceMode && "opacity-40 cursor-not-allowed",
                  )}
                >
                  {q}×
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between mt-4 pt-4 border-t border-white/[0.06] flex-wrap gap-3">
          <div className="flex gap-6 flex-wrap">
            <span className="text-xs text-muted-foreground">
              Per request: <span className="text-primary font-semibold">{maxPerRequest}</span>
            </span>
            <span className="text-xs text-muted-foreground">
              Daily: <span className="text-primary font-semibold">{usedToday}</span> / {dailyLimit}
            </span>
            <span className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Wallet className="w-3.5 h-3.5 text-neon-green" />
              Earn commission on every successful OTP
            </span>
          </div>
          <div className="w-32 h-1.5 rounded-full bg-white/[0.06]">
            <div
              className="h-full rounded-full bg-gradient-to-r from-primary to-neon-magenta transition-all duration-500"
              style={{ width: `${Math.min((usedToday / dailyLimit) * 100, 100)}%` }}
            />
          </div>
        </div>
      </GlassCard>
      )}

      {numbers.length > 0 && (() => {
        const totalPages = Math.max(1, Math.ceil(numbers.length / PAGE_SIZE));
        const safePage = Math.min(page, totalPages);
        const start = (safePage - 1) * PAGE_SIZE;
        const pageItems = numbers.slice(start, start + PAGE_SIZE);
        // Build compact page list: 1 … prev current next … last
        const pages: (number | "…")[] = [];
        if (totalPages <= 7) {
          for (let i = 1; i <= totalPages; i++) pages.push(i);
        } else {
          pages.push(1);
          if (safePage > 3) pages.push("…");
          for (let i = Math.max(2, safePage - 1); i <= Math.min(totalPages - 1, safePage + 1); i++) pages.push(i);
          if (safePage < totalPages - 2) pages.push("…");
          pages.push(totalPages);
        }
        return (
        <GlassCard>
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <div className="flex items-center gap-3 flex-wrap">
              <h3 className="font-display font-semibold text-foreground">Allocated Numbers & OTPs</h3>
              <span className="text-[10px] px-2 py-0.5 rounded bg-white/[0.05] text-muted-foreground font-mono">
                {numbers.length} total · {start + 1}–{Math.min(start + PAGE_SIZE, numbers.length)}
              </span>
            </div>
            <div className="flex gap-2 items-center flex-wrap">
              {/* Auto-release expired toggle */}
              <button
                type="button"
                onClick={() => setAutoRelease((v) => !v)}
                title={autoRelease
                  ? `Auto-release ON — expired numbers are released automatically after 60s grace (expiry: ${Math.round(expirySec / 60)}m)`
                  : `Auto-release OFF — expired numbers stay in the list until you release them manually (expiry: ${Math.round(expirySec / 60)}m)`}
                className={cn(
                  "h-8 px-3 rounded-md text-[11px] font-semibold border transition-all flex items-center gap-1.5",
                  autoRelease
                    ? "bg-neon-green/15 border-neon-green/40 text-neon-green hover:bg-neon-green/25"
                    : "bg-white/[0.04] border-white/[0.1] text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
                )}
              >
                <span className={cn("w-1.5 h-1.5 rounded-full", autoRelease ? "bg-neon-green animate-pulse" : "bg-muted-foreground/50")} />
                Auto-release {autoRelease ? "ON" : "OFF"}
              </button>
              <span className="h-8 px-3 rounded-md border border-white/[0.08] bg-white/[0.03] text-[11px] font-semibold text-muted-foreground inline-flex items-center">
                Expiry {Math.round(expirySec / 60)}m
              </span>
              <span className="h-8 px-3 rounded-md border border-white/[0.08] bg-white/[0.03] text-[11px] font-semibold text-muted-foreground inline-flex items-center">
                Expiry {Math.round(expirySec / 60)}m
              </span>
              {/* Desktop notification permission */}
              <button
                type="button"
                onClick={requestNotifPermission}
                title={
                  notifPerm === "granted" ? "Desktop notifications enabled — you'll get a popup + sound when OTP arrives, even on another tab"
                  : notifPerm === "denied" ? "Notifications blocked. Enable in browser site settings."
                  : "Click to enable desktop notifications + sound when OTP arrives"
                }
                className={cn(
                  "h-8 w-8 flex items-center justify-center rounded-md border transition-all",
                  notifPerm === "granted"
                    ? "bg-primary/15 border-primary/40 text-primary"
                    : notifPerm === "denied"
                      ? "bg-destructive/10 border-destructive/30 text-destructive"
                      : "bg-white/[0.04] border-white/[0.1] text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
                )}
              >
                {notifPerm === "denied" ? <BellOff className="w-3.5 h-3.5" /> : <Bell className="w-3.5 h-3.5" />}
              </button>
              <Button size="sm" variant="outline" onClick={copyAll} className="glass border-white/[0.1] hover:bg-white/[0.06] text-xs">
                <Copy className="w-3.5 h-3.5 mr-1" /> Copy All
              </Button>
              <Button size="sm" variant="outline" onClick={downloadTxt} className="glass border-white/[0.1] hover:bg-white/[0.06] text-xs">
                <Download className="w-3.5 h-3.5 mr-1" /> Download .txt
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-[36px_auto_1fr_120px_100px_90px_80px] gap-3 px-4 py-2 text-xs font-semibold text-muted-foreground border-b border-white/[0.06] mb-1">
            <span className="text-center">#</span>
            <span className="w-2" />
            <span>Number</span>
            <span>Operator</span>
            <span>OTP</span>
            <span>Time</span>
            <span className="text-right">Actions</span>
          </div>

          <div className="space-y-1">
            {pageItems.map((n, idx) => {
              const allocAt = n.allocated_at || serverNowSec;
              // For received OTPs: show how long it took to arrive.
              // For pending: show REMAINING time before expiry (counts down).
              const elapsed = serverNowSec - allocAt;
              const remaining = Math.max(0, expirySec - elapsed);
              const tookSec = n.otp && n.otp_received_at ? n.otp_received_at - allocAt : 0;
              const isExpired = !n.otp && remaining <= 0;
              const serial = start + idx + 1; // global serial across pages
              const isFlashing = flashOtpIds.has(n.id);
              return (
              <div
                key={n.id}
                className={cn(
                  "grid grid-cols-[36px_auto_1fr_120px_100px_90px_80px] gap-3 items-center px-4 py-3 rounded-lg border transition-all duration-300",
                  isFlashing
                    ? "bg-neon-green/[0.12] border-neon-green/60 shadow-[0_0_24px_-4px_hsl(var(--neon-green)/0.55)] ring-1 ring-neon-green/40 animate-pulse"
                    : n.otp
                      ? "bg-neon-green/[0.04] border-neon-green/20 hover:bg-neon-green/[0.08]"
                      : "bg-white/[0.02] border-white/[0.04] hover:bg-white/[0.04]"
                )}
              >
                <span className={cn(
                  "text-[11px] font-mono font-semibold text-center tabular-nums",
                  n.otp ? "text-neon-green" : "text-muted-foreground"
                )}>
                  {serial}
                </span>
                <div className={cn(
                  "w-2 h-2 rounded-full",
                  n.otp ? "bg-neon-green" : isExpired ? "bg-neon-red" : n.status === "active" ? "bg-neon-amber animate-pulse" : "bg-neon-red"
                )} />
                <div className="flex items-center gap-2">
                  <span className={cn(
                    "text-sm font-mono",
                    n.otp ? "text-neon-green font-semibold" : "text-foreground"
                  )}>{n.phone_number}</span>
                  <button
                    onClick={() => copyItem(n.id, n.phone_number, "num")}
                    className="p-1 rounded hover:bg-white/[0.06] text-muted-foreground hover:text-primary transition-colors"
                    title="Copy number"
                  >
                    {copiedId === n.id ? <Check className="w-3.5 h-3.5 text-neon-green" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
                <span className="text-xs text-muted-foreground">{n.operator || "—"}</span>
                <div className="flex items-center gap-1">
                  {n.otp ? (
                    <>
                      <span className="text-sm font-mono text-neon-green font-semibold">{n.otp}</span>
                      <button
                        onClick={() => copyItem(n.id, n.otp!, "otp")}
                        className="p-1 rounded hover:bg-white/[0.06] text-muted-foreground hover:text-neon-green transition-colors"
                        title="Copy OTP"
                      >
                        {copiedOtpId === n.id ? <Check className="w-3.5 h-3.5 text-neon-green" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground italic">Waiting...</span>
                  )}
                </div>
                <span
                  className={cn(
                    "text-xs font-mono tabular-nums",
                    n.otp
                      ? "text-neon-green/80"
                      : isExpired
                        ? "text-neon-red"
                        : remaining < 60
                          ? "text-neon-red"
                          : remaining < 180
                            ? "text-neon-amber"
                            : "text-muted-foreground"
                  )}
                  title={
                    n.otp
                      ? `OTP arrived in ${fmtDuration(tookSec)}`
                      : isExpired
                        ? "Expired — release & try again"
                        : `Time left before this number expires (admin-set: ${Math.round(expirySec/60)} min)`
                  }
                >
                  {n.otp
                    ? fmtDuration(tookSec)
                    : isExpired
                      ? "expired"
                      : `${fmtDuration(remaining)} left`}
                </span>
                <div className="flex justify-end">
                  <span className={cn(
                    "px-2 py-0.5 rounded-full text-[10px] font-semibold",
                    n.otp ? "bg-neon-green/10 text-neon-green" : "bg-neon-amber/10 text-neon-amber"
                  )}>
                    {n.otp ? "Received" : "Pending"}
                  </span>
                </div>
              </div>
              );
            })}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t border-white/[0.06] flex-wrap gap-2">
              <span className="text-[11px] text-muted-foreground">
                Page <span className="text-foreground font-semibold">{safePage}</span> of {totalPages}
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={safePage === 1}
                  className="h-8 w-8 flex items-center justify-center rounded-md bg-white/[0.04] border border-white/[0.08] text-muted-foreground hover:text-foreground hover:bg-white/[0.08] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  aria-label="Previous page"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                {pages.map((p, i) =>
                  p === "…" ? (
                    <span key={`e${i}`} className="px-2 text-xs text-muted-foreground">…</span>
                  ) : (
                    <button
                      key={p}
                      onClick={() => setPage(p)}
                      className={cn(
                        "h-8 min-w-8 px-2 rounded-md text-xs font-semibold transition-colors border",
                        p === safePage
                          ? "bg-gradient-to-r from-primary to-neon-magenta text-primary-foreground border-transparent"
                          : "bg-white/[0.04] border-white/[0.08] text-foreground hover:bg-white/[0.08]"
                      )}
                    >
                      {p}
                    </button>
                  )
                )}
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={safePage === totalPages}
                  className="h-8 w-8 flex items-center justify-center rounded-md bg-white/[0.04] border border-white/[0.08] text-muted-foreground hover:text-foreground hover:bg-white/[0.08] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  aria-label="Next page"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </GlassCard>
        );
      })()}
    </div>
  );
};

export default AgentGetNumber;

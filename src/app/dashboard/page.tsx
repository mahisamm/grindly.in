"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import { Logo } from "@/components/Brand";
import { CountUp } from "@/components/Motion";
import { PROFF_FIELDS, CONTACT_FIELDS } from "@/lib/proffQuestions";

// @novnc/novnc touches `window`/browser globals at module load time — a
// static import crashes Next's server-side prerender of this page ("window
// is not defined"), even though this component is only ever mounted in the
// browser. ssr: false keeps it out of the server bundle entirely.
const ConnectViewer = dynamic(() => import("@/components/ConnectViewer"), { ssr: false });

// ── Types ──────────────────────────────────────────────────────────────────

type App = {
  id: string;
  jobTitle: string;
  company: string;
  url: string | null;
  matchScore: number;
  status: string;
  reason: string | null;
  outcome: string | null;
  appliedAt: string | null;
  createdAt: string;
};
type Report = {
  id: string;
  date: string;
  matchedCount: number;
  appliedCount: number;
  failedCount: number;
  summary: string;
};
type Integration = {
  platform: string;
  status: string;
  connectedAt: string | null;
  otpRequired?: boolean;
  lastError?: string | null;
  connectToken?: string | null;
};
type ResumeAnalysis = {
  score: number;
  grade: string;
  strengths: string[];
  issues: string[];
  suggestions: string[];
};

type RawProfile = {
  id: string;
  skills: string;
  maxPerDay: number;
  minMatchScore: number;
  autoApply: boolean;
  preferredDomains: string;
  preferredLocations: string;
  workMode: string;
  experienceLevel: string | null;
  stipendMin: number;
  excludedCompanies: string;
  phone: string | null;
  gpa: number | null;
  resumeScore: number | null;
  resumeSuggestions: string | null;
  resumeName: string | null;
  matchQualityRating: number | null;
  resumeParseFailed: boolean;
  reportChannel: string;
};
type Me = {
  user: {
    id: string;
    name: string | null;
    email: string;
    paid: boolean;
    plan: string;
    status: string;
    role?: string;
    slackConnected: boolean;
    slackUserId: string | null;
    internshalaConnected: boolean;
    gmailConnected: boolean;
    gmailScanEnabled: boolean;
    internshalaLoginEnabled: boolean;
  };
  profile: RawProfile | null;
  applications: App[];
  reports: Report[];
  stats: {
    matched: number;
    approved: number;
    reviewed: number;
    applied: number;
    skipped: number;
    failed: number;
    avgScore: number;
    interviews: number;
    offers: number;
    outcomeReported: number;
    interviewRate: number | null;
  };
  integrations: Integration[];
};

type ProfileForm = {
  preferredDomains: string[];
  preferredLocations: string[];
  workMode: string;
  experienceLevel: string;
  stipendMin: number;
  minMatchScore: number;
  excludedCompanies: string[];
  autoApply: boolean;
  phone: string;
  gpa: string;
  reportChannel: string;
};

// ── Constants ──────────────────────────────────────────────────────────────

const PLATFORM_META: Record<string, { label: string; color: string; icon: string }> = {
  linkedin: { label: "LinkedIn", color: "text-[#0077B5]", icon: "in" },
  internshala: { label: "Internshala", color: "text-[#00aaff]", icon: "IS" },
  naukri: { label: "Naukri", color: "text-[#f47c2d]", icon: "NK" },
  unstop: { label: "Unstop", color: "text-[#6C63FF]", icon: "UN" },
  indeed: { label: "Indeed", color: "text-[#2557A7]", icon: "ID" },
};

// Platforms surfaced in the UI right now. Code/adapters for the others stay
// intact — add their key here to re-enable them in the dashboard later.
const VISIBLE_PLATFORMS = ["internshala"];

const STATUS_STYLE: Record<string, string> = {
  applied:  "bg-accent/15 text-accent",
  approved: "bg-brand/15 text-brand-2",
  matched:  "bg-surface-2 text-muted",
  skipped:  "bg-surface-2 text-muted",
  failed:   "bg-danger/15 text-danger",
};

const STATUS_LABEL: Record<string, string> = {
  applied:  "applied",
  approved: "approved ✓",
  matched:  "awaiting",
  skipped:  "skipped",
  failed:   "failed",
};

// user-reported outcomes per applied job — the beta interview-rate signal
const OUTCOME_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Outcome?" },
  { value: "interview", label: "Got interview 🎉" },
  { value: "offer", label: "Got offer 🏆" },
  { value: "rejected", label: "Rejected" },
  { value: "no_response", label: "No response" },
];

const OUTCOME_STYLE: Record<string, string> = {
  interview: "border-accent/50 text-accent",
  offer: "border-accent/60 text-accent",
  rejected: "border-danger/40 text-danger",
  no_response: "border-border text-muted",
};

function scoreColor(s: number) {
  if (s >= 75) return "text-accent";
  if (s >= 55) return "text-brand-2";
  return "text-muted";
}

function resumeScoreColor(s: number) {
  if (s >= 75) return "text-accent";
  if (s >= 55) return "text-brand-2";
  if (s >= 40) return "text-warn";
  return "text-danger";
}

function resumeGradeBg(g: string) {
  if (g === "A") return "bg-accent/20 text-accent border-accent/40";
  if (g === "B") return "bg-brand/20 text-brand-2 border-brand/40";
  if (g === "C") return "bg-warn/20 text-warn border-warn/40";
  return "bg-danger/20 text-danger border-danger/40";
}

const PLAN_CAP: Record<string, number> = { starter: 10, pro: 30 };
const PAGE_SIZE = 20;

// ── Helpers ────────────────────────────────────────────────────────────────

function parseJ<T>(v: string | null | undefined, fallback: T): T {
  try { return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}

function profileToForm(p: RawProfile): ProfileForm {
  return {
    preferredDomains: parseJ<string[]>(p.preferredDomains, []),
    preferredLocations: parseJ<string[]>(p.preferredLocations, []),
    workMode: p.workMode || "any",
    experienceLevel: p.experienceLevel || "student",
    stipendMin: p.stipendMin ?? 0,
    minMatchScore: p.minMatchScore ?? 55,
    excludedCompanies: parseJ<string[]>(p.excludedCompanies, []),
    autoApply: p.autoApply ?? true,
    phone: p.phone || "",
    gpa: p.gpa != null ? String(p.gpa) : "8.0",
    reportChannel: p.reportChannel || "email",
  };
}

// ── TagInput ───────────────────────────────────────────────────────────────

function TagInput({ value, onChange, placeholder }: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [input, setInput] = useState("");

  function add(raw: string) {
    const tags = raw.split(",").map((t) => t.trim()).filter(Boolean);
    const next = [...value];
    for (const t of tags) if (!next.includes(t)) next.push(t);
    onChange(next);
    setInput("");
  }

  return (
    <div className="flex flex-wrap gap-1.5 rounded-lg border border-border bg-surface p-2 min-h-[42px]">
      {value.map((t) => (
        <span key={t} className="flex items-center gap-1 rounded-md bg-brand/15 px-2 py-0.5 text-sm text-brand-2">
          {t}
          <button type="button" onClick={() => onChange(value.filter((x) => x !== t))} className="text-muted hover:text-danger">×</button>
        </span>
      ))}
      <input
        value={input}
        onChange={(e) => {
          // Commit on comma (typed or pasted) here rather than in onKeyDown —
          // keydown reads stale `input` state under fast typing and drops tags.
          const v = e.target.value;
          if (v.includes(",")) add(v);
          else setInput(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); add(input); }
          if (e.key === "Backspace" && !input && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => input && add(input)}
        placeholder={value.length === 0 ? placeholder : ""}
        className="flex-1 min-w-[120px] bg-transparent text-sm outline-none placeholder:text-muted"
      />
    </div>
  );
}

// ── Main ───────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState<"profile" | "applications" | "integrations" | "reports">("applications");
  const [filter, setFilter] = useState<string>("all");
  const [connectingPlatform, setConnectingPlatform] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ platform: string; token: string } | null>(null);
  const [page, setPage] = useState(0);
  const [profileForm, setProfileForm] = useState<ProfileForm | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [approvingAll, setApprovingAll] = useState(false);
  const [analyzingResume, setAnalyzingResume] = useState(false);
  const [editingSkills, setEditingSkills] = useState(false);
  const [skillsDraft, setSkillsDraft] = useState<string[]>([]);
  const [skillsSaving, setSkillsSaving] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [surveyRating, setSurveyRating] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err" | "info"; text: string } | null>(null);
  const [slackIdDraft, setSlackIdDraft] = useState("");
  const [slackBusy, setSlackBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/me");
    if (res.status === 401) {
      router.replace("/login");
      return;
    }
    if (res.ok) {
      const data = await res.json() as Me;
      setMe(data);
      // Init profile form once (don't overwrite edits in progress)
      setProfileForm((prev) => {
        if (prev) return prev;
        return data.profile ? profileToForm(data.profile) : null;
      });
    }
    setLoading(false);
  }, [router]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- polling: load on mount + every 4s
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  // Reset page when filter changes
  // eslint-disable-next-line react-hooks/set-state-in-effect -- reset pagination on filter/tab change
  useEffect(() => { setPage(0); }, [filter, tab]);

  // First-run walkthrough — show once per browser after the user is loaded
  useEffect(() => {
    if (!me) return;
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- react to async user load
      if (!localStorage.getItem("grindly_onboarded")) setShowOnboarding(true);
    } catch {}
  }, [me]);

  // Handle OAuth callback query params (Gmail connect / error)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    let next: { kind: "ok" | "err" | "info"; text: string } | null = null;
    if (params.get("gmailConnected") === "1") {
      next = { kind: "ok", text: "Gmail connected. The agent will now auto-detect interview emails." };
    } else if (params.get("gmailError") === "unavailable") {
      next = { kind: "info", text: "Gmail interview tracking is pending Google review — it'll switch on automatically once approved." };
    } else if (params.get("gmailError")) {
      next = { kind: "err", text: "Gmail connection failed. Please try again." };
    }
    if (next) {
      window.history.replaceState({}, "", "/dashboard");
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time URL→toast after history cleanup
      setNotice(next);
    }
  }, []);

  async function togglePause() {
    if (!me) return;
    const action = me.user.status === "paused" ? "resume" : "pause";
    await fetch("/api/agent/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    load();
  }

  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/login";
  }

  async function runAgent() {
    setRunning(true);
    setNotice(null);
    try {
      const res = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice({ kind: "err", text: data.error || "Couldn't start the agent." });
        setRunning(false);
        return;
      }
      const runId: string | null = data.runId ?? null;
      if (!runId) { setTimeout(() => setRunning(false), 4000); return; }

      const started = Date.now();
      const poll = async () => {
        try {
          const r = await fetch(`/api/agent/run?id=${runId}`);
          const s = await r.json();
          if (s.status === "done") {
            const x = s.result || {};
            setNotice({ kind: "ok", text: `Agent finished — applied ${x.applied ?? 0}, matched ${x.matched ?? 0}, failed ${x.failed ?? 0}.` });
            setRunning(false); load(); return;
          }
          if (s.status === "failed") {
            setNotice({ kind: "err", text: `Agent run failed: ${s.error || "unknown error"}` });
            setRunning(false); return;
          }
          if (Date.now() - started > 120000) {
            setNotice({ kind: "info", text: "Agent still running — results will appear shortly." });
            setRunning(false); load(); return;
          }
          setTimeout(poll, 2000);
        } catch {
          setRunning(false);
        }
      };
      setTimeout(poll, 2000);
    } catch {
      setNotice({ kind: "err", text: "Network error starting the agent." });
      setRunning(false);
    }
  }

  // ── Remote-browser connect flow — every platform (including Internshala)
  // goes through this: shows the user a live view of a real login browser
  // so they type their own password and handle any captcha/OTP themselves
  // (see agent/connect_service.py). Grindly never sees or stores the
  // password. ──
  async function connectPlatform(platform: string) {
    setConnectingPlatform(platform);
    setNotice({ kind: "info", text: "Preparing your secure login window…" });
    const res = await fetch("/api/integrations/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setNotice({ kind: "err", text: data.error || "Couldn't open the login browser." });
      setConnectingPlatform(null);
      return;
    }
    // Poll integration status until connected, or the connect service's own
    // session window (5 min) elapses. In production a connectToken shows up
    // once the remote-browser session is actually live — open the viewer
    // then, not before (nothing to show until the browser exists).
    // eslint-disable-next-line react-hooks/purity -- runs at click time (event handler), not during render
    const started = Date.now();
    const deadline = started + 300_000;
    let opened = false;
    const pollConnect = async () => {
      if (Date.now() > deadline) {
        setConnectingPlatform(null);
        setViewer(null);
        setNotice({ kind: "err", text: "Login window didn't open in time — please try Connect again." });
        return;
      }
      const r = await fetch("/api/integrations").catch(() => null);
      if (r?.ok) {
        const d = await r.json().catch(() => ({}));
        const row = (d.integrations as Integration[] ?? []).find(i => i.platform === platform);
        if (row?.status === "connected") { setConnectingPlatform(null); setViewer(null); setNotice({ kind: "ok", text: `${platform} connected.` }); load(); return; }
        if (row?.connectToken) { opened = true; setNotice(null); setViewer({ platform, token: row.connectToken }); }
        else if (!opened && Date.now() - started > 12_000) {
          // Still no token after a bit — almost always means another user's
          // connect session is using the single shared browser. Say so
          // instead of leaving them staring at a spinner.
          setNotice({ kind: "info", text: "Waiting for the login window — someone else may be connecting right now. Holding your place…" });
        }
        if (row?.status !== "connecting" && !row?.connectToken) { setConnectingPlatform(null); setViewer(null); return; }
      }
      setTimeout(pollConnect, 2000);
    };
    setTimeout(pollConnect, 2000);
  }

  async function disconnectPlatform(platform: string) {
    const res = await fetch("/api/integrations/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform }),
    }).catch(() => null);
    if (!res || !res.ok) {
      setNotice({ kind: "err", text: "Couldn't disconnect — please try again." });
      return;
    }
    load();
  }

  async function saveProfile() {
    if (!profileForm) return;
    setProfileSaving(true);
    const body = {
      ...profileForm,
      gpa: parseFloat(profileForm.gpa) || 8.0,
    };
    const res = await fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setProfileSaving(false);
    if (res.ok) {
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 3000);
      load();
    } else {
      setNotice({ kind: "err", text: "Failed to save profile. Please try again." });
    }
  }

  async function analyzeResume() {
    setAnalyzingResume(true);
    try {
      const res = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analyzeOnly: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setAnalyzingResume(false); return; }

      const runId: string | null = data.runId ?? null;
      if (!runId) { setTimeout(() => { setAnalyzingResume(false); load(); }, 4000); return; }

      const started = Date.now();
      const poll = async () => {
        try {
          const r = await fetch(`/api/agent/run?id=${runId}`);
          const s = await r.json();
          if (s.status === "done" || s.status === "failed") {
            setAnalyzingResume(false); load(); return;
          }
          if (Date.now() - started > 60_000) { setAnalyzingResume(false); load(); return; }
          setTimeout(poll, 2000);
        } catch { setAnalyzingResume(false); }
      };
      setTimeout(poll, 2000);
    } catch { setAnalyzingResume(false); }
  }

  async function approveApplication(id: string) {
    setApprovingId(id);
    const res = await fetch("/api/applications/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => null);
    setApprovingId(null);
    if (!res || !res.ok) {
      setNotice({ kind: "err", text: "Couldn't approve — please try again." });
      return;
    }
    load();
  }

  async function approveAllApplications() {
    setApprovingAll(true);
    const res = await fetch("/api/applications/approve-all", { method: "POST" }).catch(() => null);
    setApprovingAll(false);
    if (!res || !res.ok) {
      setNotice({ kind: "err", text: "Couldn't approve all — please try again." });
      return;
    }
    load();
  }

  function patchForm<K extends keyof ProfileForm>(key: K, val: ProfileForm[K]) {
    setProfileForm((f) => f ? { ...f, [key]: val } : f);
  }

  async function setOutcome(id: string, outcome: string) {
    const prevOutcome = me?.applications.find((a) => a.id === id)?.outcome ?? null;
    // optimistic — reflect immediately, reconcile on next poll
    setMe((m) => m ? { ...m, applications: m.applications.map((a) => a.id === id ? { ...a, outcome: outcome || null } : a) } : m);
    const res = await fetch("/api/applications/outcome", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, outcome: outcome || null }),
    }).catch(() => null);
    if (!res || !res.ok) {
      // roll back — the optimistic update above never actually saved
      setMe((m) => m ? { ...m, applications: m.applications.map((a) => a.id === id ? { ...a, outcome: prevOutcome } : a) } : m);
      setNotice({ kind: "err", text: "Couldn't save outcome — please try again." });
      return;
    }
    load();
  }

  async function saveSkills() {
    setSkillsSaving(true);
    const res = await fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skills: skillsDraft }),
    });
    setSkillsSaving(false);
    if (res.ok) {
      setEditingSkills(false);
      load();
    } else {
      setNotice({ kind: "err", text: "Failed to save skills. Please try again." });
    }
  }

  async function submitSurvey(rating: number) {
    setSurveyRating(rating);
    const res = await fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matchQualityRating: rating }),
    }).catch(() => null);
    if (!res || !res.ok) {
      setNotice({ kind: "err", text: "Couldn't save your rating — please try again." });
      return;
    }
    load();
  }

  function dismissOnboarding() {
    try { localStorage.setItem("grindly_onboarded", "1"); } catch {}
    setShowOnboarding(false);
  }

  async function connectSlack() {
    const id = slackIdDraft.trim();
    if (!id) return;
    setSlackBusy(true);
    setNotice(null);
    const res = await fetch("/api/slack/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slackUserId: id }),
    });
    setSlackBusy(false);
    if (!res.ok) { setNotice({ kind: "err", text: "Couldn't save Slack ID. Use your member ID (U…)." }); return; }
    setSlackIdDraft("");
    setNotice({ kind: "ok", text: "Slack connected. Hit 'Send test' to confirm it lands." });
    load();
  }

  async function testSlack() {
    setSlackBusy(true);
    setNotice(null);
    const res = await fetch("/api/slack/test", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    setSlackBusy(false);
    if (!res.ok) { setNotice({ kind: "err", text: data.error || "Test failed." }); return; }
    setNotice(data.stub
      ? { kind: "info", text: "Sent to local outbox (stub). Set SLACK_BOT_TOKEN in .env for real Slack DMs." }
      : { kind: "ok", text: "Test message sent — check your Slack DMs." });
  }

  async function disconnectSlack() {
    setSlackBusy(true);
    await fetch("/api/slack/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slackUserId: "", disconnect: true }),
    }).catch(() => {});
    setSlackBusy(false);
    load();
  }

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center text-muted">
        Loading dashboard…
      </main>
    );
  }

  if (!me) {
    return (
      <main className="grid-bg min-h-screen flex items-center justify-center px-5">
        <div className="glass rounded-2xl p-8 text-center max-w-sm glow">
          <Logo size={30} />
          <p className="mt-4 text-muted">Not logged in.</p>
          <div className="mt-5 flex justify-center gap-2">
            <Link href="/login" className="inline-block press rounded-lg brand-gradient px-5 py-2.5 font-medium text-white">Log in</Link>
          </div>
        </div>
      </main>
    );
  }

  const skills: string[] = me.profile ? parseJ<string[]>(me.profile.skills, []) : [];
  const filteredApps = filter === "all"
    ? me.applications
    : me.applications.filter((a) => a.status === filter);
  const totalPages = Math.ceil(filteredApps.length / PAGE_SIZE);
  const apps = filteredApps.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const integrations = (me.integrations ?? []).filter((i) => VISIBLE_PLATFORMS.includes(i.platform));
  const connectedCount = integrations.filter((i) => i.status === "connected").length;
  const cap = PLAN_CAP[me.user.plan] ?? 10;
  const matchedCount = me.applications.filter((a) => a.status === "matched").length;
  const outcomeApps = me.applications.filter((a) => a.status === "applied" && a.outcome);
  const responseRate = outcomeApps.length > 0
    ? Math.round((outcomeApps.filter((a) => a.outcome !== "no_response").length / outcomeApps.length) * 100)
    : null;

  return (
    <main className="grid-bg min-h-screen">
      {/* First-run walkthrough */}
      {showOnboarding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" onClick={dismissOnboarding}>
          <div className="glass rounded-2xl p-6 max-w-md w-full glow" onClick={(e) => e.stopPropagation()}>
            <Logo size={26} />
            <h2 className="mt-4 font-display text-xl font-semibold">Welcome to Grindly</h2>
            <p className="text-sm text-muted mt-1">Here&apos;s how the agent works — three steps:</p>
            <ol className="mt-4 space-y-3 text-sm">
              <li className="flex gap-3">
                <span className="shrink-0 size-6 rounded-full bg-brand/20 text-brand-2 flex items-center justify-center text-xs font-bold">1</span>
                <span><span className="font-medium">Complete your profile.</span> Set domains, locations, and your match threshold in the Profile tab.</span>
              </li>
              <li className="flex gap-3">
                <span className="shrink-0 size-6 rounded-full bg-brand/20 text-brand-2 flex items-center justify-center text-xs font-bold">2</span>
                <span><span className="font-medium">Connect Internshala.</span> In Integrations, click Connect and log in yourself in the live browser window that opens — the agent applies on your behalf afterward.</span>
              </li>
              <li className="flex gap-3">
                <span className="shrink-0 size-6 rounded-full bg-brand/20 text-brand-2 flex items-center justify-center text-xs font-bold">3</span>
                <span><span className="font-medium">Run the agent.</span> It scores and applies to matches. Then tell us the outcome on each application so we can prove it works.</span>
              </li>
            </ol>
            <p className="mt-4 text-xs text-muted">Tip: connect Internshala first — <span className="text-foreground">Run agent</span> unlocks once a platform is linked.</p>
            <button onClick={dismissOnboarding} className="mt-5 w-full press rounded-lg brand-gradient px-4 py-2.5 text-sm font-medium text-white hover:opacity-90 transition">
              Got it — let&apos;s go
            </button>
          </div>
        </div>
      )}

      {/* Remote-browser login viewer — live only while a connect session is open */}
      {viewer && (
        <ConnectViewer
          platform={viewer.platform}
          token={viewer.token}
          onClose={() => { setViewer(null); setConnectingPlatform(null); }}
        />
      )}

      {/* top bar */}
      <header className="sticky top-0 z-30 glass">
        <div className="mx-auto max-w-6xl px-5 h-16 flex items-center justify-between">
          <Link href="/"><Logo /></Link>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-sm">
              <span className={`size-2 rounded-full ${
                me.user.status === "paused" ? "bg-warn"
                : me.user.status === "active" && connectedCount > 0 ? "bg-accent pulse-dot"
                : "bg-muted"
              }`} />
              <span className="hidden sm:inline">
                {me.user.status === "paused" ? "Paused"
                 : me.user.status === "active" && connectedCount > 0 ? "Agent active"
                 : "Setup incomplete"}
              </span>
            </span>
            <button onClick={togglePause} className="text-sm text-muted hover:text-foreground transition">
              {me.user.status === "paused" ? "Resume" : "Pause"}
            </button>
            {me.user.role === "admin" && (
              <Link href="/admin" className="rounded-full border border-ink bg-ink px-3 py-1.5 text-sm font-semibold text-[#f5f3ea] transition hover:opacity-80">
                Admin
              </Link>
            )}
            <button onClick={logout} className="text-sm text-muted hover:text-foreground transition">Log out</button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-5 py-8">
        {/* header row */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-3xl font-semibold tracking-tight">
              Hi {me.user.name || me.user.email.split("@")[0]}
            </h1>
            <p className="text-muted text-sm mt-1">
              Plan: <span className="capitalize text-foreground font-medium">{me.user.plan}</span>
              {" "}· {cap}/day cap · firewall ≥{me.profile?.minMatchScore ?? 55}
              {" "}· <span className={connectedCount > 0 ? "text-accent" : "text-muted"}>
                {connectedCount} platform{connectedCount !== 1 ? "s" : ""} connected
              </span>
              {responseRate !== null && (
                <>
                  {" "}· {responseRate}% response rate
                  <span className="text-xs"> (of {outcomeApps.length} tracked — quality of match matters more than volume)</span>
                </>
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/applications"
              className="rounded-lg border border-border px-4 py-2.5 text-sm font-medium hover:border-brand/60 transition"
              title="See the exact resume sent per application (interview call prep)"
            >
              Call prep ↗
            </Link>
            {connectedCount === 0 ? (
              <button
                disabled
                onClick={() => setTab("integrations")}
                title="Connect Internshala first to run the agent"
                className="rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-muted cursor-not-allowed opacity-60"
              >
                Connect Internshala first
              </button>
            ) : (
              <button
              onClick={() => runAgent()}
              disabled={running || connectedCount === 0}
              title={connectedCount === 0 ? "Connect Internshala first" : "Find + apply to live matches"}
              className="press rounded-lg brand-gradient px-4 py-2.5 text-sm font-medium text-white hover:opacity-90 transition disabled:opacity-50"
            >
              {running ? "Agent running…" : "Run agent"}
            </button>
            )}
          </div>
        </div>

        {/* run / connect result notice */}
        {notice && (
          <div className={`mt-5 flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${
            notice.kind === "ok" ? "border-accent/40 bg-accent/10 text-accent"
            : notice.kind === "err" ? "border-danger/40 bg-danger/10 text-danger"
            : "border-brand/40 bg-brand/10 text-brand-2"
          }`}>
            <span>{notice.text}</span>
            <button onClick={() => setNotice(null)} className="shrink-0 text-muted hover:text-foreground transition">×</button>
          </div>
        )}

        {/* banners */}
        {connectedCount === 0 && me.user.internshalaLoginEnabled && (
          <div className="mt-5 rounded-xl border border-brand/40 bg-brand/10 px-4 py-3 text-sm">
            <span className="font-medium">Connect Internshala</span>{" "}
            <span className="text-muted">so the agent can find and apply to matches for you.</span>{" "}
            <button onClick={() => setTab("integrations")} className="underline text-brand-2 ml-1">Set up integrations →</button>
          </div>
        )}
        {matchedCount > 0 && (
          <div className="mt-3 flex items-center justify-between rounded-xl border border-brand/40 bg-brand/10 px-4 py-3 text-sm">
            <div>
              <span className="font-medium">{matchedCount} job{matchedCount !== 1 ? "s" : ""} awaiting your approval.</span>{" "}
              <button onClick={() => { setTab("applications"); setFilter("matched"); }} className="underline text-brand-2 ml-1">Review & approve →</button>
            </div>
            <button
              onClick={approveAllApplications}
              disabled={approvingAll}
              className="ml-4 shrink-0 rounded-lg border border-brand/40 px-3 py-1.5 text-xs text-brand-2 hover:bg-brand/10 transition disabled:opacity-50"
            >
              {approvingAll ? "Approving…" : `Approve all ${matchedCount}`}
            </button>
          </div>
        )}

        {/* reconnect warnings */}
        {integrations.filter((i) => i.status === "needs_login").map((i) => (
          <div key={i.platform} className="mt-3 flex items-center justify-between rounded-xl border border-warn/40 bg-warn/10 px-4 py-2.5 text-sm text-warn">
            <span>{PLATFORM_META[i.platform]?.label ?? i.platform} login expired — reconnect to resume live applications.</span>
            <button onClick={() => setTab("integrations")} className="ml-4 shrink-0 rounded-lg border border-warn/60 px-3 py-1 text-xs hover:bg-warn/20 transition">Reconnect</button>
          </div>
        ))}

        {/* stats — "Matched" is jobs awaiting your approval, NOT everything the
            agent looked at. "Reviewed" is that total. Conflating the two is what
            made a run that matched nothing report "Matched 49". */}
        <div className="mt-6 grid grid-cols-3 sm:grid-cols-5 gap-3">
          {([
            ["Reviewed", me.stats.reviewed, "text-muted", "Listings the agent scored"],
            ["Matched", me.stats.matched, "text-foreground", "Cleared your threshold — awaiting your approval"],
            ["Applied", me.stats.applied, "text-accent", "Actually submitted"],
            ["Failed", me.stats.failed, "text-danger", "Submission failed"],
            ["Avg match", me.stats.avgScore, "text-brand-2", "Average score across everything reviewed"],
          ] as const).map(([label, val, c, help]) => (
            <div key={label} className="sticker tilt rounded-2xl bg-surface p-4" role="region" aria-label={`${label}: ${val}. ${help}`} title={help}>
              <div className={`display text-4xl ${c}`} aria-hidden="true"><CountUp value={val} /></div>
              <div className="text-xs text-muted mt-1" aria-hidden="true">{label}</div>
            </div>
          ))}
        </div>

        {/* Interview funnel — the headline "is this working?" panel */}
        {me.stats.applied > 0 && (
          <div className="mt-4 rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs uppercase tracking-wide text-muted">Outcomes</div>
              {me.stats.interviewRate != null && (
                <div className="text-sm">
                  <span className="text-accent font-semibold">{me.stats.interviewRate}%</span>
                  <span className="text-muted"> interview rate</span>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
              <span><span className="text-foreground font-medium">{me.stats.applied}</span> <span className="text-muted">applied</span></span>
              <span className="text-muted">→</span>
              <span><span className="text-accent font-medium">{me.stats.interviews}</span> <span className="text-muted">interview{me.stats.interviews !== 1 ? "s" : ""}</span></span>
              <span className="text-muted">→</span>
              <span><span className="text-accent font-medium">{me.stats.offers}</span> <span className="text-muted">offer{me.stats.offers !== 1 ? "s" : ""}</span></span>
            </div>
            {me.stats.outcomeReported < me.stats.applied && (
              <p className="mt-2 text-xs text-muted">
                Tell us what happened on your applications — set an outcome on each row in{" "}
                <button onClick={() => { setTab("applications"); setFilter("applied"); }} className="underline text-brand-2">Applications</button>.
                {" "}{me.stats.applied - me.stats.outcomeReported} still need an outcome.
              </p>
            )}
          </div>
        )}

        {/* Match-quality survey — one tap, only after enough data + not yet rated */}
        {me.profile && me.stats.applied >= 5 && me.profile.matchQualityRating == null && surveyRating == null && (
          <div className="mt-4 rounded-xl border border-brand/40 bg-brand/10 p-4">
            <div className="text-sm font-medium mb-2">How good are the matches the agent is finding?</div>
            <div className="flex items-center gap-2">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  onClick={() => submitSurvey(n)}
                  className="size-9 rounded-lg border border-border bg-surface text-sm hover:border-brand/60 hover:bg-brand/10 transition"
                  title={`${n} / 5`}
                >
                  {n}
                </button>
              ))}
              <span className="text-xs text-muted ml-2">1 = poor · 5 = spot on</span>
            </div>
          </div>
        )}
        {surveyRating != null && (
          <div className="mt-4 rounded-xl border border-accent/40 bg-accent/10 px-4 py-3 text-sm text-accent">
            Thanks — rated {surveyRating}/5. This helps us tune the matcher.
          </div>
        )}

        {/* Resume intelligence panel */}
        {me.profile && (
          <div className="mt-6 rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs uppercase tracking-wide text-muted">Resume Intelligence</div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => { setSkillsDraft(skills); setEditingSkills((v) => !v); }}
                  className="text-xs text-brand-2 hover:text-brand transition"
                >
                  {editingSkills ? "Cancel" : "✎ Edit skills"}
                </button>
                <button
                  onClick={analyzeResume}
                  disabled={analyzingResume || !me.profile.resumeName}
                  title={!me.profile.resumeName ? "Upload a resume first" : "Re-analyze your resume with AI"}
                  className="text-xs text-brand-2 hover:text-brand transition disabled:opacity-40"
                >
                  {analyzingResume ? "Analyzing…" : "↻ Re-analyze"}
                </button>
              </div>
            </div>

            {/* Parse-failure fallback — agent told us it read no skills */}
            {me.profile.resumeParseFailed && !editingSkills && (
              <div className="mb-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
                We couldn&apos;t read skills from your resume, so matches will be weak.{" "}
                <button onClick={() => { setSkillsDraft(skills); setEditingSkills(true); }} className="underline font-medium">Add your skills manually →</button>
              </div>
            )}

            {/* Manual skills editor — fallback when parsing fails or to refine */}
            {editingSkills && (
              <div className="mb-4 rounded-lg border border-brand/40 bg-brand/5 p-3">
                <div className="text-xs text-muted mb-2">Add or remove skills the agent should match on. Type and press Enter.</div>
                <TagInput value={skillsDraft} onChange={setSkillsDraft} placeholder="e.g. React, Python, SQL" />
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={saveSkills}
                    disabled={skillsSaving}
                    className="press rounded-lg brand-gradient px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 transition disabled:opacity-50"
                  >
                    {skillsSaving ? "Saving…" : "Save skills"}
                  </button>
                  <button onClick={() => setEditingSkills(false)} className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-foreground transition">Cancel</button>
                </div>
              </div>
            )}

            {me.profile.resumeScore != null ? (() => {
              const analysis: ResumeAnalysis = me.profile!.resumeSuggestions
                ? (parseJ<ResumeAnalysis>(me.profile!.resumeSuggestions, {
                    score: me.profile!.resumeScore ?? 0,
                    grade: "?",
                    strengths: [],
                    issues: [],
                    suggestions: [],
                  }))
                : { score: me.profile!.resumeScore, grade: "?", strengths: [], issues: [], suggestions: [] };
              return (
                <div className="space-y-3">
                  {/* Score + grade row */}
                  <div className="flex items-center gap-4">
                    <div className="flex items-baseline gap-1">
                      <span className={`text-4xl font-bold ${resumeScoreColor(analysis.score)}`}>
                        {analysis.score}
                      </span>
                      <span className="text-muted text-sm">/100</span>
                    </div>
                    <span className={`rounded-md border px-2.5 py-1 text-sm font-bold ${resumeGradeBg(analysis.grade)}`}>
                      {analysis.grade}
                    </span>
                    {me.profile!.resumeName && (
                      <span className="text-xs text-muted truncate max-w-[180px]">{me.profile!.resumeName}</span>
                    )}
                  </div>

                  {/* Two-column: issues + suggestions */}
                  <div className="grid sm:grid-cols-2 gap-3">
                    {analysis.issues.length > 0 && (
                      <div>
                        <div className="text-xs font-medium text-warn mb-1">Issues found</div>
                        <ul className="space-y-1">
                          {analysis.issues.map((issue, i) => (
                            <li key={i} className="text-xs text-muted flex gap-1.5">
                              <span className="text-warn shrink-0">✗</span>{issue}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {analysis.suggestions.length > 0 && (
                      <div>
                        <div className="text-xs font-medium text-accent mb-1">AI suggestions</div>
                        <ul className="space-y-1">
                          {analysis.suggestions.map((s, i) => (
                            <li key={i} className="text-xs text-muted flex gap-1.5">
                              <span className="text-accent shrink-0">→</span>{s}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>

                  {/* Skills strip */}
                  {skills.length > 0 && (
                    <div>
                      <div className="text-xs text-muted mb-1.5">Extracted skills</div>
                      <div className="flex flex-wrap gap-1.5">
                        {skills.map((s) => (
                          <span key={s} className="rounded-md bg-brand/15 px-2 py-0.5 text-xs text-brand-2">{s}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })() : (
              <div className="text-sm text-muted">
                {me.profile.resumeName
                  ? "Analysis in progress — check back in a moment."
                  : "Upload your resume in Onboarding to get an AI quality score and improvement suggestions."}
                {skills.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {skills.map((s) => (
                      <span key={s} className="rounded-md bg-brand/15 px-2 py-0.5 text-xs text-brand-2">{s}</span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* tabs */}
        <div className="mt-8 flex items-center gap-2 border-b border-border overflow-x-auto scrollbar-none">
          {(["profile", "applications", "integrations", "reports"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`shrink-0 px-4 py-2.5 text-sm capitalize border-b-2 -mb-px transition ${
                tab === t ? "border-brand text-foreground" : "border-transparent text-muted hover:text-foreground"
              }`}
            >
              {t}
              {t === "integrations" && connectedCount > 0 && (
                <span className="ml-1.5 rounded-full bg-accent/20 px-1.5 py-0.5 text-[10px] text-accent">{connectedCount}</span>
              )}
              {t === "applications" && matchedCount > 0 && (
                <span className="ml-1.5 rounded-full bg-warn/20 px-1.5 py-0.5 text-[10px] text-warn">{matchedCount}</span>
              )}
            </button>
          ))}
        </div>

        {/* ── PROFILE ── */}
        {tab === "profile" && profileForm && (
          <div className="mt-6 max-w-xl space-y-6">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted mb-4">Targeting</h2>
              <div className="space-y-4">
                {PROFF_FIELDS.filter((f) => f.group === "Targeting").map((f) => (
                  <div key={f.key}>
                    <label htmlFor={`field-${f.key}`} className="block text-sm font-medium mb-1">{f.label}</label>
                    <p className="text-xs text-muted mb-1.5">{f.help}</p>
                    {f.type === "tags" && (
                      <TagInput
                        value={profileForm[f.key as keyof ProfileForm] as string[]}
                        onChange={(v) => patchForm(f.key as keyof ProfileForm, v as ProfileForm[keyof ProfileForm])}
                        placeholder={f.placeholder}
                      />
                    )}
                    {f.type === "select" && (
                      <select
                        id={`field-${f.key}`}
                        value={String(profileForm[f.key as keyof ProfileForm])}
                        onChange={(e) => patchForm(f.key as keyof ProfileForm, e.target.value as ProfileForm[keyof ProfileForm])}
                        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none"
                      >
                        {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted mb-4">Firewall / limits</h2>
              <div className="space-y-4">
                {PROFF_FIELDS.filter((f) => f.group === "Firewall / limits").map((f) => (
                  <div key={f.key}>
                    <label htmlFor={`field-${f.key}`} className="block text-sm font-medium mb-1">{f.label}</label>
                    <p className="text-xs text-muted mb-1.5">{f.help}</p>
                    {f.type === "tags" && (
                      <TagInput
                        value={profileForm[f.key as keyof ProfileForm] as string[]}
                        onChange={(v) => patchForm(f.key as keyof ProfileForm, v as ProfileForm[keyof ProfileForm])}
                        placeholder={f.placeholder}
                      />
                    )}
                    {f.type === "number" && (
                      <div className="flex items-center gap-2">
                        <input
                          id={`field-${f.key}`}
                          type="number"
                          min={0}
                          value={String(profileForm[f.key as keyof ProfileForm])}
                          onChange={(e) => patchForm(f.key as keyof ProfileForm, Number(e.target.value) as ProfileForm[keyof ProfileForm])}
                          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm w-32 outline-none"
                        />
                        {f.suffix && <span className="text-sm text-muted">{f.suffix}</span>}
                      </div>
                    )}
                    {f.type === "toggle" && (
                      <label className="flex items-center gap-3 cursor-pointer">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={profileForm.autoApply}
                          onClick={() => patchForm("autoApply", !profileForm.autoApply)}
                          className={`relative w-11 h-6 rounded-full transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-brand ${profileForm.autoApply ? "bg-accent" : "bg-surface-2 border border-border"}`}
                        >
                          <span className={`absolute top-1 size-4 rounded-full bg-white transition-transform ${profileForm.autoApply ? "translate-x-6" : "translate-x-1"}`} />
                        </button>
                        <span className="text-sm">{profileForm.autoApply ? "On — agent preps every match, you tap Approve to send" : "Off — agent only shortlists, nothing gets prepped until you turn this on"}</span>
                      </label>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted mb-4">Reports</h2>
              <p className="text-xs text-muted mb-4">
                Where the agent sends your daily report and any &quot;action needed&quot; alerts.
                Change this whenever you like.
              </p>
              <div className="grid grid-cols-2 gap-3 max-w-md">
                {([
                  ["email", "📧", "Email", me.user.email],
                  ["slack", "💬", "Slack DM", me.user.slackConnected ? "Connected" : "Needs setup below"],
                ] as const).map(([value, icon, label, sub]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => patchForm("reportChannel", value)}
                    className={`rounded-xl border-2 p-4 text-left transition ${profileForm.reportChannel === value ? "border-brand bg-brand/5" : "border-border hover:border-brand/40"}`}
                  >
                    <div className="text-xl mb-1">{icon}</div>
                    <div className="font-semibold text-sm">{label}</div>
                    <div className="text-xs text-muted mt-0.5 truncate">{sub}</div>
                  </button>
                ))}
              </div>
              {profileForm.reportChannel === "slack" && !me.user.slackConnected && (
                <p className="mt-3 text-xs text-warn">
                  Slack isn&apos;t connected yet — connect it in the Integrations tab, or your
                  reports will fall back to email.
                </p>
              )}
            </div>

            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted mb-4">Form fill</h2>
              <p className="text-xs text-muted mb-4">These values are filled into platform application forms automatically.</p>
              <div className="space-y-4">
                {CONTACT_FIELDS.map((f) => (
                  <div key={f.key}>
                    <label htmlFor={`field-${f.key}`} className="block text-sm font-medium mb-1">{f.label}</label>
                    <p className="text-xs text-muted mb-1.5">{f.help}</p>
                    <div className="flex items-center gap-2">
                      <input
                        id={`field-${f.key}`}
                        type={f.type}
                        value={String(profileForm[f.key as keyof ProfileForm] ?? "")}
                        placeholder={("placeholder" in f ? f.placeholder : undefined)}
                        onChange={(e) => patchForm(f.key as keyof ProfileForm, e.target.value as ProfileForm[keyof ProfileForm])}
                        className="rounded-lg border border-border bg-surface px-3 py-2 text-sm w-48 outline-none"
                      />
                      {"suffix" in f && f.suffix && <span className="text-sm text-muted">{f.suffix}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <button
              onClick={saveProfile}
              disabled={profileSaving}
              className="press rounded-lg brand-gradient px-5 py-2.5 text-sm font-medium text-white hover:opacity-90 transition disabled:opacity-50"
            >
              {profileSaving ? "Saving…" : profileSaved ? "Saved ✓" : "Save profile"}
            </button>
          </div>
        )}

        {/* ── APPLICATIONS ── */}
        {tab === "applications" && (
          <div className="mt-4">
            <div className="flex flex-wrap gap-2 mb-3 text-sm">
              {["all", "applied", "approved", "matched", "skipped", "failed"].map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  aria-pressed={filter === f}
                  className={`rounded-md px-2.5 py-1 capitalize transition ${
                    filter === f ? "bg-surface-2 text-foreground" : "text-muted hover:text-foreground"
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>

            <div className="text-xs text-muted mb-2">
              {filteredApps.length} result{filteredApps.length !== 1 ? "s" : ""}
              {totalPages > 1 && ` · page ${page + 1} of ${totalPages}`}
            </div>

            {apps.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-10 text-center text-muted">
                No applications yet. Connect Internshala, then hit <span className="text-foreground">Run agent</span> to start applying.
              </div>
            ) : (
              <div className="space-y-2">
                {apps.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-start sm:items-center justify-between rounded-xl border border-border bg-surface px-4 py-3 hover:border-brand/40 transition gap-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium truncate">{a.jobTitle}</span>
                        {a.url && (
                          <a href={a.url} target="_blank" rel="noreferrer" className="text-xs text-brand-2 hover:underline shrink-0">
                            view ↗
                          </a>
                        )}
                      </div>
                      <div className="text-sm text-muted mt-0.5">{a.company}</div>
                      {a.reason && (
                        <div className="text-xs text-muted mt-1 truncate max-w-md" title={a.reason}>
                          {a.reason}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <div className="text-right">
                        <div className={`font-mono text-lg ${scoreColor(a.matchScore)}`}>{a.matchScore}</div>
                        <div className="text-[10px] text-muted">match</div>
                      </div>
                      <span className={`rounded-md px-2 py-1 text-xs ${STATUS_STYLE[a.status] || "bg-surface-2 text-muted"}`}>
                        {STATUS_LABEL[a.status] ?? a.status}
                      </span>
                      {(a.status === "applied" || a.status === "approved") && (
                        <select
                          value={a.outcome ?? ""}
                          onChange={(e) => setOutcome(a.id, e.target.value)}
                          title="Tell us what happened — this is how we measure if the agent works"
                          className={`rounded-md border bg-surface px-2 py-1 text-xs outline-none ${OUTCOME_STYLE[a.outcome ?? ""] ?? "border-border text-muted"}`}
                        >
                          {OUTCOME_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      )}
                      {a.status === "matched" && (
                        <button
                          onClick={() => approveApplication(a.id)}
                          disabled={approvingId === a.id}
                          className="rounded-md border border-brand/40 px-2.5 py-1 text-xs text-brand-2 hover:bg-brand/10 transition disabled:opacity-50"
                        >
                          {approvingId === a.id ? "…" : "Approve"}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* pagination */}
            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-between text-sm">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="rounded-lg border border-border px-3 py-1.5 text-muted hover:text-foreground disabled:opacity-30 transition"
                >
                  ← Previous
                </button>
                <span className="text-muted">
                  {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filteredApps.length)} of {filteredApps.length}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="rounded-lg border border-border px-3 py-1.5 text-muted hover:text-foreground disabled:opacity-30 transition"
                >
                  Next →
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── INTEGRATIONS ── */}
        {tab === "integrations" && (
          <div className="mt-4">
            <p className="text-sm text-muted mb-4">
              Connect Internshala so the agent can apply for you. You log in yourself in a live
              browser window — Grindly never sees or stores your password.
            </p>

            {(() => {
              const intern = integrations.find((i) => i.platform === "internshala")
                ?? { platform: "internshala", status: "disconnected", connectedAt: null, otpRequired: false, lastError: null };
              const isConnected = intern.status === "connected";
              const isConnecting = intern.status === "connecting" || connectingPlatform === "internshala";

              return (
                <div className={`rounded-xl border p-4 transition ${
                  isConnected ? "border-accent/40 bg-accent/5" : "border-border bg-surface"
                }`}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold rounded-md px-1.5 py-0.5 border text-[#00aaff] border-current">IS</span>
                      <span className="font-medium">Internshala</span>
                    </div>
                    <span className={`text-xs rounded-full px-2 py-0.5 ${
                      isConnected ? "bg-accent/20 text-accent"
                      : isConnecting ? "bg-brand/20 text-brand-2"
                      : "bg-surface-2 text-muted"
                    }`}>
                      {isConnected ? "Connected" : isConnecting ? "Connecting…" : "Not connected"}
                    </span>
                  </div>

                  {/* last error from a previous connect attempt */}
                  {intern.lastError && !isConnected && (
                    <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
                      {intern.lastError}
                    </div>
                  )}

                  {isConnected ? (
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted">Logged in — the agent applies via your account.</span>
                      <button onClick={() => disconnectPlatform("internshala")} className="text-xs text-muted hover:text-danger transition">Disconnect</button>
                    </div>
                  ) : isConnecting ? (
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-brand-2">Opening your secure login window…</span>
                      <button onClick={() => disconnectPlatform("internshala")} className="text-xs text-muted hover:text-danger transition">Cancel</button>
                    </div>
                  ) : !me.user.internshalaLoginEnabled ? (
                    <div className="rounded-lg border border-brand/30 bg-brand/5 px-3 py-2.5 text-xs text-muted">
                      <span className="font-medium text-brand-2">Rolling out.</span>{" "}
                      Internshala auto-apply is being enabled for accounts in waves — yours isn&apos;t live yet.
                      We&apos;ll switch it on for you soon. Nothing to do here for now.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-xs text-muted">
                        You&apos;ll get a live view of a real browser to log into Internshala yourself —
                        enter your password, solve any captcha, and any one-time code the same way you
                        normally would. Grindly never sees or stores your password.
                      </p>
                      <button
                        onClick={() => connectPlatform("internshala")}
                        className="w-full press rounded-lg brand-gradient px-3 py-2 text-sm font-medium text-white hover:opacity-90 transition disabled:opacity-50"
                      >
                        Connect Internshala
                      </button>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Slack daily reports */}
            <div className="mt-5 rounded-xl border border-border bg-surface p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold rounded-md px-1.5 py-0.5 border text-[#4A154B] border-current">Sl</span>
                  <span className="font-medium">Slack reports</span>
                </div>
                <span className={`text-xs rounded-full px-2 py-0.5 ${me.user.slackConnected ? "bg-accent/20 text-accent" : "bg-surface-2 text-muted"}`}>
                  {me.user.slackConnected ? "Connected" : "Not connected"}
                </span>
              </div>
              <p className="text-xs text-muted mb-3">
                Get the daily run report and session-expiry alerts as a Slack DM. Paste your Slack
                member ID (Slack → your profile → ⋮ → Copy member ID). Needs <code className="text-foreground">SLACK_BOT_TOKEN</code> in <code className="text-foreground">.env</code> for real delivery.
              </p>
              {me.user.slackConnected ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-muted">Sending to <span className="text-foreground font-mono">{me.user.slackUserId}</span></span>
                  <button onClick={testSlack} disabled={slackBusy} className="rounded-lg border border-border px-3 py-1.5 text-xs hover:border-brand/60 transition disabled:opacity-50">Send test</button>
                  <button onClick={disconnectSlack} disabled={slackBusy} className="text-xs text-muted hover:text-danger transition">Disconnect</button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={slackIdDraft}
                    onChange={(e) => setSlackIdDraft(e.target.value)}
                    placeholder="U0XXXXXXX"
                    className="rounded-lg border border-border bg-surface px-3 py-2 text-sm w-44 outline-none font-mono"
                  />
                  <button onClick={connectSlack} disabled={slackBusy || !slackIdDraft.trim()} className="press rounded-lg brand-gradient px-3 py-2 text-sm font-medium text-white hover:opacity-90 transition disabled:opacity-50">
                    {slackBusy ? "…" : "Connect Slack"}
                  </button>
                </div>
              )}
            </div>

            {/* Gmail email scanning — hidden until gmail.readonly clears Google
                verification (server gate: GMAIL_SCAN_ENABLED). Showing it while
                the restricted scope is unverified sends users into a consent
                screen Google blocks. */}
            {me.user.gmailScanEnabled && (
            <div className="mt-5 rounded-xl border border-border bg-surface p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-base">📧</span>
                  <span className="font-medium">Gmail — interview tracker</span>
                </div>
                <span className={`text-xs rounded-full px-2 py-0.5 ${me.user.gmailConnected ? "bg-accent/20 text-accent" : "bg-surface-2 text-muted"}`}>
                  {me.user.gmailConnected ? "Connected" : "Not connected"}
                </span>
              </div>
              <p className="text-xs text-muted mb-3">
                Connect Gmail (read-only) so the agent automatically detects interview calls, offers, and
                rejections from companies you applied to — and notifies you via Slack or email without you
                having to manually update each application.
              </p>
              {me.user.gmailConnected ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-accent">✓ Gmail scanning active</span>
                  <button
                    onClick={async () => {
                      const r = await fetch("/api/gmail/scan", { method: "POST" });
                      const j = await r.json().catch(() => ({}));
                      if (r.ok) setNotice({ kind: "ok", text: `Scanned ${j.scanned ?? 0} emails · ${j.detected?.length ?? 0} new outcomes detected.` });
                      else setNotice({ kind: "err", text: j.error ?? "Scan failed." });
                    }}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs hover:border-brand/60 transition"
                  >
                    Scan now
                  </button>
                  <button
                    onClick={async () => {
                      await fetch("/api/gmail/status", { method: "DELETE" });
                      load();
                    }}
                    className="text-xs text-muted hover:text-danger transition"
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <a
                  href="/api/auth/gmail"
                  className="press inline-flex items-center gap-2 rounded-lg border-2 border-ink bg-surface sticker-sm px-4 py-2 text-sm font-medium hover:bg-surface-2 transition"
                >
                  <svg width="16" height="16" viewBox="0 0 48 48" fill="none">
                    <path d="M47.532 24.552c0-1.636-.132-3.2-.388-4.704H24.48v8.896h12.956c-.568 2.952-2.22 5.456-4.692 7.132v5.912h7.572c4.432-4.072 6.988-10.072 6.988-17.236z" fill="#4285F4"/>
                    <path d="M24.48 48c6.48 0 11.916-2.148 15.888-5.812l-7.572-5.912c-2.148 1.44-4.896 2.288-8.316 2.288-6.396 0-11.82-4.32-13.748-10.128H2.9v6.1C6.856 42.86 15.088 48 24.48 48z" fill="#34A853"/>
                    <path d="M10.732 28.436A14.4 14.4 0 0 1 9.9 24c0-1.54.264-3.036.732-4.436v-6.1H2.9A23.952 23.952 0 0 0 .48 24c0 3.864.924 7.524 2.42 10.536l8.332-6.1z" fill="#FBBC05"/>
                    <path d="M24.48 9.552c3.604 0 6.836 1.24 9.38 3.672l6.972-6.972C36.388 2.352 30.96 0 24.48 0 15.088 0 6.856 5.14 2.9 13.464l7.832 6.1C12.66 13.872 18.084 9.552 24.48 9.552z" fill="#EA4335"/>
                  </svg>
                  Connect Gmail (read-only)
                </a>
              )}
            </div>
            )}

            <div className="mt-5 rounded-xl border border-border bg-surface p-4 text-sm text-muted">
              <p className="font-medium text-foreground mb-1">How live applications work</p>
              <ol className="list-decimal pl-5 space-y-1 text-sm">
                <li>Click <strong>Connect Internshala</strong> above and log in yourself in the live browser window — handles any captcha or one-time code the same way you normally would.</li>
                <li>Once connected, the agent reuses that session to log in on our server.</li>
                <li>Click <strong>Run agent</strong> on this dashboard to start applying.</li>
                <li>The agent applies up to <strong>{cap}</strong> internships/day on Internshala.</li>
              </ol>
            </div>
          </div>
        )}

        {/* ── REPORTS ── */}
        {tab === "reports" && (
          <div className="mt-4 space-y-3">
            {me.reports.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-10 text-center text-muted">
                No daily reports yet. They appear after each agent run.
              </div>
            ) : (
              me.reports.map((r) => (
                <div key={r.id} className="rounded-xl border border-border bg-surface p-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                    <div className="font-medium">{r.date}</div>
                    <div className="text-sm text-muted">
                      <span className="text-accent">{r.appliedCount} applied</span> · {r.matchedCount} matched · {r.failedCount} failed
                    </div>
                  </div>
                  <p className="mt-2 text-sm text-muted whitespace-pre-line">{r.summary}</p>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </main>
  );
}

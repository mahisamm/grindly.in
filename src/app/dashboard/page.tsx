"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import { Logo } from "@/components/Brand";
import { CountUp } from "@/components/Motion";
import { PROFF_FIELDS, CONTACT_FIELDS } from "@/lib/proffQuestions";
import { planCap } from "@/lib/plans";

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
  // JSON array: what this role asks for that you don't show. The actionable half of
  // a match score, and the list you want in front of you if they call.
  missingSkills: string | null;
  // Apply Kit — prepared before you ever open the form. Null until the agent's
  // next pass generates it (or, for cover letter/resume, if generation failed).
  coverLetterText: string | null;
  resumeVersionId: string | null;
  // JSON array [{q, a, source}] — only present on platforms the agent can read
  // screening questions from ahead of time. See agent/questions.py.
  answersJson: string | null;
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
  // Mechanical check of what an applicant tracking system can actually extract from
  // the file — not an opinion about the writing. `readable: false` means a scanned
  // or image-based PDF: it looks perfect on screen and is a blank page to a parser,
  // which silently sinks every application made with it.
  ats?: { readable: boolean; chars: number; warnings: string[] };
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
  resumeTexName: string | null;
  // Verdict from compiling the untouched .tex at upload — see agent/worker.py:latex_check.
  // "ok" is the ONLY value that lets the agent tailor; anything else means it sends
  // the master unchanged, and the user is told so instead of it failing in silence.
  resumeTexStatus: string | null;
  resumeTexDetail: string | null;
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
    accessStatus?: string;
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
    // Matches that have come due — the batch the user can actually send today.
    ready: number;
    // The rest of the month's pipeline. A count only: the server never sends the
    // list (see src/lib/pipeline.ts).
    queued: number;
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
  quota: {
    kind: "trial" | "daily";
    cap: number;
    used: number;
    remaining: number;
  };
  integrations: Integration[];
  // Non-null while a user-triggered agent run is queued/running server-side.
  // Drives the persistent "Agent working…" button so it survives reloads.
  activeRun?: { id: string; status: string; startedAt: string } | null;
  notifications?: {
    unread: number;
    items: { id: string; tier: string; title: string; body: string; read: boolean; createdAt: string }[];
  };
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
const VISIBLE_PLATFORMS = ["linkedin", "internshala", "naukri", "unstop", "indeed"];

const STATUS_STYLE: Record<string, string> = {
  applied:  "bg-accent/15 text-accent",
  approved: "bg-brand/15 text-brand-2",
  matched:  "bg-surface-2 text-muted",
  skipped:  "bg-surface-2 text-muted",
  failed:   "bg-danger/15 text-danger",
};

// One consistent vocabulary the user can actually model:
//   Matched → (you open + submit on the platform) → To submit → (you confirm) → Applied
const STATUS_LABEL: Record<string, string> = {
  applied:  "Applied",
  approved: "To submit",
  matched:  "Matched",
  skipped:  "Skipped",
  failed:   "Failed",
};

// user-reported outcomes per applied job — the beta interview-rate signal
const OUTCOME_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "How'd it go?" },
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

/** Every state except "ok" means the agent will send the master resume unchanged.
 *  Saying so is the entire point — a .tex that silently does nothing is worse than
 *  no .tex at all, because the user thinks the feature is working. */
const TEX_STATUS: Record<string, { label: string; tone: string }> = {
  checking:       { label: "Checking…",          tone: "border-border text-muted" },
  ok:             { label: "Ready",              tone: "border-accent text-accent" },
  no_sections:    { label: "No Skills section",  tone: "border-warn text-warn" },
  compile_failed: { label: "Won't compile",      tone: "border-danger text-danger" },
  page_mismatch:  { label: "Doesn't match PDF",  tone: "border-warn text-warn" },
  no_compiler:    { label: "Compiler offline",   tone: "border-warn text-warn" },
  unsafe:         { label: "Refused",            tone: "border-danger text-danger" },
  missing:        { label: "Not found",          tone: "border-warn text-warn" },
};

/** One upload slot: shows the file currently on record and lets the user replace it. */
function ResumeSlot({
  label, hint, current, accept, busy, onPick, status, detail,
}: {
  label: string;
  hint: string;
  current: string | null;
  accept: string;
  busy: boolean;
  onPick: (f: File) => void;
  status?: string | null;
  detail?: string | null;
}) {
  const s = status ? TEX_STATUS[status] : null;
  return (
    <label
      className={`block cursor-pointer rounded-xl border-2 border-dashed p-4 transition ${
        busy ? "border-brand bg-brand/5 opacity-70" : "border-border hover:border-brand/50"
      }`}
    >
      <input
        type="file"
        accept={accept}
        className="sr-only"
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          // Reset the input so re-picking the SAME filename fires change again —
          // otherwise a user who re-exports resume.pdf and uploads it a second time
          // gets no event at all, and the app silently keeps the old file.
          e.target.value = "";
          if (f) onPick(f);
        }}
      />
      <div className="text-sm font-medium">{label}</div>
      <div className="mt-0.5 text-xs text-muted">{hint}</div>
      <div className="mt-2.5 flex items-center gap-2">
        {current ? (
          <span className="truncate rounded-md bg-surface-2 px-2 py-1 text-xs" title={current}>
            {current}
          </span>
        ) : (
          <span className="text-xs text-muted">Nothing uploaded</span>
        )}
        {s && (
          <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${s.tone}`}>
            {s.label}
          </span>
        )}
        <span className="ml-auto shrink-0 text-xs text-brand-2">
          {busy ? "Uploading…" : current ? "Replace" : "Upload"}
        </span>
      </div>
      {detail && status !== "ok" && (
        <p className="mt-2 text-xs text-warn">{detail}</p>
      )}
      {detail && status === "ok" && (
        <p className="mt-2 text-xs text-muted">{detail}</p>
      )}
    </label>
  );
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

// Turn a finished run's result into a clear, honest notice. Every terminal
// outcome gets its own line — the old code only ever said "0 ready to send, 0
// sent", so a run the agent DEFERRED (outside daytime hours) or REFUSED (no
// platform) looked exactly like a broken agent. Now each says why.
function describeRun(x: {
  deferred?: string; error?: string; message?: string;
  ready?: number; matched?: number; applied?: number; failed?: number; pipeline?: number;
}): { kind: "ok" | "err" | "info"; text: string } {
  if (x.deferred) {
    return { kind: "info", text: "The automatic daily sweep only runs 9am–9pm IST — but your manual runs work any time. Tap Run agent again to go now." };
  }
  if (x.error || (x.message && x.ready == null && x.matched == null && x.applied == null)) {
    return { kind: "info", text: x.message || "Connect a job platform, then run the agent." };
  }
  const matched = x.matched ?? 0;
  const ready = x.ready ?? 0;
  const applied = x.applied ?? 0;
  const failed = x.failed ?? 0;
  const pipeline = x.pipeline ?? 0;
  if (matched === 0 && applied === 0 && ready === 0) {
    return {
      kind: "info",
      text: "Agent finished — no new matches this run. It keeps looking, but you can surface more now by widening your domains/locations or lowering the match threshold in Profile.",
    };
  }
  return {
    kind: "ok",
    text: `Agent finished — ${matched} new match${matched !== 1 ? "es" : ""} found`
      + (ready ? `, ${ready} ready to submit now` : "")
      + (applied ? `, ${applied} sent` : "")
      + (failed ? `, ${failed} failed` : "")
      + (pipeline ? `. ${pipeline} lined up for the coming days.` : "."),
  };
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
  // Set true when the user closes the login viewer. The connect poll loop below
  // checks it so a closed viewer is never re-opened by the next status tick —
  // without this, the server token stays live for the full 5-min window and
  // each poll re-sets `viewer`, so the modal "reopens" the instant you close it.
  const connectAbort = useRef(false);
  // Run-poll bookkeeping so the "Agent working…" state is owned by exactly one
  // poll loop and a finished run is never re-announced. pollingRunId = the run
  // we're actively polling; finishedRunId = the last run we already reported, so
  // a stale activeRun from /api/me (up to one 12s tick behind) can't re-fire the
  // completion notice.
  const pollingRunId = useRef<string | null>(null);
  const finishedRunId = useRef<string | null>(null);
  const [page, setPage] = useState(0);
  const [profileForm, setProfileForm] = useState<ProfileForm | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [approvingAll, setApprovingAll] = useState(false);
  const [confirmingSubmittedId, setConfirmingSubmittedId] = useState<string | null>(null);
  // Row whose submit URL was just copied — flips the button to "Copied ✓" briefly.
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // The application the user just opened to submit on the platform. When they
  // switch back to this tab we surface a one-tap "Did you submit it?" prompt so
  // the loop closes even if they forget to come back and confirm.
  const [pendingSubmit, setPendingSubmit] = useState<{ id: string; label: string } | null>(null);
  const [showReturnPrompt, setShowReturnPrompt] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [analyzingResume, setAnalyzingResume] = useState(false);
  const [uploading, setUploading] = useState<"master" | "tex" | null>(null);
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
      // Gated beta: an unapproved account never reaches the app UI. Admins pass.
      if (data.user.role !== "admin" && data.user.accessStatus !== "approved") {
        router.replace("/waitlist");
        return;
      }
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- polling: load on mount + on an interval
    load();
    // 12s, not 4s: on a single-core host, 100 open dashboards polling /api/me
    // (≈6 DB queries each) would starve the browser-worker of CPU. The agent is
    // a background product — near-real-time dashboard refresh isn't worth the load.
    const t = setInterval(load, 12000);
    return () => clearInterval(t);
  }, [load]);

  // Reset page when filter changes
  // eslint-disable-next-line react-hooks/set-state-in-effect -- reset pagination on filter/tab change
  useEffect(() => { setPage(0); }, [filter, tab]);

  // When the user tabs back after opening a listing to submit, ask them to
  // confirm — this is what closes the "opened it, never came back to mark it"
  // gap that left applications stuck and skewed the response-rate metric.
  useEffect(() => {
    if (!pendingSubmit) return;
    const onFocus = () => setShowReturnPrompt(true);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [pendingSubmit]);

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

  async function deleteAccount() {
    const sure = window.confirm(
      "Delete your account permanently? This erases your profile, resumes, and every " +
      "application record. It cannot be undone."
    );
    if (!sure) return;
    const res = await fetch("/api/account", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    if (res.ok) {
      window.location.href = "/login";
    } else {
      setNotice({ kind: "err", text: "Couldn't delete the account. Please try again." });
    }
  }

  // Poll one run to completion and report it. Owned by a single caller at a time
  // (pollingRunId guard) so runAgent's kick and the reload-resume effect below
  // can both point at the same run without double-announcing it.
  const pollRun = useCallback((runId: string) => {
    if (pollingRunId.current === runId || finishedRunId.current === runId) return;
    pollingRunId.current = runId;
    const started = Date.now();
    const step = async () => {
      try {
        const r = await fetch(`/api/agent/run?id=${runId}`);
        const s = await r.json();
        if (s.status === "done" || s.status === "failed" || s.status === "cancelled") {
          pollingRunId.current = null;
          finishedRunId.current = runId;
          setRunning(false);
          if (s.status === "done") setNotice(describeRun(s.result || {}));
          else if (s.status === "failed") setNotice({ kind: "err", text: `Agent run failed: ${s.error || "unknown error"}. Try again — if it keeps failing, reach out and we'll dig in.` });
          load();
          return;
        }
        // Still queued/running. Keep polling for the completion notice; the
        // button stays "working" via activeRun even past this window.
        if (Date.now() - started > 240_000) { pollingRunId.current = null; load(); return; }
        setTimeout(step, 2500);
      } catch {
        pollingRunId.current = null;
        load();
      }
    };
    setTimeout(step, 2000);
  }, [load]);

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
      finishedRunId.current = null; // fresh run — allow its completion to report
      pollRun(runId);
    } catch {
      setNotice({ kind: "err", text: "Network error starting the agent." });
      setRunning(false);
    }
  }

  // Resume tracking a run the server says is still in flight — e.g. after a
  // reload or tab-switch. Without this the button reset to "Run agent" even
  // though the agent was still working, and the completion notice was lost.
  // (Declared after pollRun so it isn't referenced before its initializer.)
  useEffect(() => {
    const ar = me?.activeRun;
    if (ar && (ar.status === "queued" || ar.status === "running")) pollRun(ar.id);
    // Depend on the id/status primitives, not the activeRun object, so this only
    // re-fires when the actual run changes — not on every /api/me poll tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.activeRun?.id, me?.activeRun?.status, pollRun]);

  // ── Remote-browser connect flow — every platform (including Internshala)
  // goes through this: shows the user a live view of a real login browser
  // so they type their own password and handle any captcha/OTP themselves
  // (see agent/connect_service.py). Grindly never sees or stores the
  // password. ──
  async function connectPlatform(platform: string) {
    connectAbort.current = false;
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
    // This is event-driven polling state, not render output.
    // eslint-disable-next-line react-hooks/purity
    const started = Date.now();
    // Sit a little past the server's 420s session window so the client never
    // declares "didn't open in time" while the remote login is still live
    // (e.g. the user is fetching an email verification code).
    const deadline = started + 450_000;
    let opened = false;
    const pollConnect = async () => {
      // User closed the viewer — stop; never re-open a window they dismissed.
      if (connectAbort.current) return;
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

  // Closing the login viewer cancels the attempt: stop the poll loop from
  // re-opening it, drop the local UI state, and tell the server to tear down
  // the remote-browser session (best-effort) so a half-finished login isn't
  // left running for the full timeout.
  function cancelConnect(platform: string) {
    connectAbort.current = true;
    setViewer(null);
    setConnectingPlatform(null);
    void fetch("/api/integrations/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform }),
    }).catch(() => {}).finally(() => load());
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

  /** Replace the master resume or the LaTeX source. A new master clears the
   *  skills/score derived from the old one server-side, so `load()` afterwards is
   *  what makes the re-analysis visible. */
  async function uploadResume(file: File, kind: "master" | "tex") {
    setUploading(kind);
    const body = new FormData();
    body.append("file", file);
    const res = await fetch("/api/resume", { method: "POST", body }).catch(() => null);
    setUploading(null);
    if (!res || !res.ok) {
      const msg = res ? ((await res.json().catch(() => ({}))) as { error?: string }).error : null;
      setNotice({ kind: "err", text: msg || "Couldn't upload that file — please try again." });
      return;
    }
    setNotice({
      kind: "ok",
      text: kind === "tex"
        ? "LaTeX source saved — the agent can now tailor without touching your layout."
        : "Resume updated. Re-reading your skills now; the agent uses it from the next run.",
    });
    load();
  }

  // One tap = consent + open. Approves the match server-side (quota + due-date
  // enforced there), then opens the real listing so the user submits it on the
  // platform. Replaces the old two-step "Prepare" then "Open & submit".
  async function openAndSubmit(a: App) {
    setApprovingId(a.id);
    // Open the tab synchronously inside the click so the browser doesn't treat
    // it as a popup — we point it at the listing (or a blank tab we fill in once
    // approve returns, for rows that carry no url).
    const tab = a.url ? window.open(a.url, "_blank", "noopener,noreferrer") : null;
    const res = await fetch("/api/applications/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: a.id }),
    }).catch(() => null);
    setApprovingId(null);
    if (!res || !res.ok) {
      if (tab) tab.close();
      const msg = res?.status === 402
        ? "You've hit today's application limit — the agent picks up again tomorrow."
        : "Couldn't open that application — please try again.";
      setNotice({ kind: "err", text: msg });
      return;
    }
    setPendingSubmit({ id: a.id, label: `${a.jobTitle} — ${a.company}` });
    if (!a.url) {
      setNotice({ kind: "info", text: "This one has no direct link — open it from your job platform, then confirm below." });
    }
    load();
  }

  async function reopen(a: App) {
    if (a.url) window.open(a.url, "_blank", "noopener,noreferrer");
    setPendingSubmit({ id: a.id, label: `${a.jobTitle} — ${a.company}` });
  }

  async function approveAllApplications() {
    setApprovingAll(true);
    const res = await fetch("/api/applications/approve-all", { method: "POST" }).catch(() => null);
    setApprovingAll(false);
    if (!res || !res.ok) {
      setNotice({ kind: "err", text: "Couldn't prepare those applications — please try again." });
      return;
    }
    setNotice({ kind: "ok", text: `Lined up ${readyCount} to submit — each carries its link, and we emailed you the list. Open the "To submit" tab.` });
    load();
  }

  // The UI now asks explicitly with a Yes/No prompt, so no native confirm() —
  // callers only reach here when the user has said they submitted it.
  async function confirmManualSubmission(id: string) {
    setConfirmingSubmittedId(id);
    if (pendingSubmit?.id === id) { setPendingSubmit(null); setShowReturnPrompt(false); }
    const res = await fetch("/api/applications/submitted", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => null);
    setConfirmingSubmittedId(null);
    if (!res || !res.ok) {
      setNotice({ kind: "err", text: "Couldn't record that submission — please try again." });
      return;
    }
    setNotice({ kind: "ok", text: "Submission recorded. Tell us the outcome here later — it's how we know the agent works." });
    load();
  }

  function dismissReturnPrompt() {
    setShowReturnPrompt(false);
    setPendingSubmit(null);
  }

  // Copy a listing's submit URL so the user can paste it anywhere (or hand it to
  // someone). Falls back silently if the clipboard API is blocked.
  async function copyText(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
    } catch {
      setNotice({ kind: "info", text: "Couldn't access the clipboard — long-press the link to copy it." });
    }
  }

  async function toggleNotifications() {
    const willOpen = !notifOpen;
    setNotifOpen(willOpen);
    // Opening the panel clears the unread badge. Optimistic locally, then persist.
    if (willOpen && me?.notifications?.unread) {
      setMe((m) =>
        m && m.notifications
          ? { ...m, notifications: { unread: 0, items: m.notifications.items.map((i) => ({ ...i, read: true })) } }
          : m,
      );
      await fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      }).catch(() => {});
    }
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
  const resumeAts = me.profile?.resumeSuggestions
    ? parseJ<ResumeAnalysis>(me.profile.resumeSuggestions, {} as ResumeAnalysis).ats
    : undefined;
  const filteredApps = filter === "all"
    ? me.applications
    : me.applications.filter((a) => a.status === filter);
  const totalPages = Math.ceil(filteredApps.length / PAGE_SIZE);
  const apps = filteredApps.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const integrations = (me.integrations ?? []).filter((i) => VISIBLE_PLATFORMS.includes(i.platform));
  const connectedCount = integrations.filter((i) => i.status === "connected").length;
  const cap = planCap(me.user.plan);
  // Every "matched" row the server sent us has already come due — the rest of the
  // month's pipeline never leaves the server (src/lib/pipeline.ts). So this is
  // "ready to send today", not "everything we found".
  const readyCount = me.stats.ready;
  // Working = a local kick in flight OR the server still holds a queued/running
  // run. The server signal is what keeps the button honest across reloads and
  // stops a second click from queuing a duplicate (the run route dedups too).
  const isRunning = running
    || me.activeRun?.status === "queued"
    || me.activeRun?.status === "running";
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
                <span><span className="font-medium">Connect a job platform.</span> Log in on the real LinkedIn, Internshala, Naukri, Unstop, or Indeed in a secure window — Grindly never sees your password.</span>
              </li>
              <li className="flex gap-3">
                <span className="shrink-0 size-6 rounded-full bg-brand/20 text-brand-2 flex items-center justify-center text-xs font-bold">3</span>
                <span><span className="font-medium">Run the agent.</span> It scores and prepares matches. You tap <span className="font-medium">Open &amp; submit</span> to send each one yourself, then track the outcome here.</span>
              </li>
            </ol>
            <p className="mt-4 text-xs text-muted">Tip: <span className="text-foreground">Run agent</span> unlocks as soon as one supported platform is connected.</p>
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
          onClose={() => cancelConnect(viewer.platform)}
        />
      )}

      {/* top bar */}
      <header className="sticky top-0 z-30 glass">
        <div className="mx-auto max-w-6xl px-5 h-16 flex items-center justify-between">
          <Link href="/"><Logo /></Link>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-sm">
              <span className={`size-2 rounded-full ${
                isRunning ? "bg-brand pulse-dot"
                : me.user.status === "paused" ? "bg-warn"
                : me.user.status === "active" && connectedCount > 0 ? "bg-accent pulse-dot"
                : "bg-muted"
              }`} />
              <span className="hidden sm:inline">
                {isRunning ? "Agent working…"
                 : me.user.status === "paused" ? "Paused"
                 : me.user.status === "active" && connectedCount > 0 ? "Agent active"
                 : "Setup incomplete"}
              </span>
            </span>
            <button onClick={togglePause} className="text-sm text-muted hover:text-foreground transition">
              {me.user.status === "paused" ? "Resume" : "Pause"}
            </button>
            {me.user.role === "admin" && (
              <Link href="/admin" className="rounded-full border border-ink bg-ink px-3 py-1.5 text-sm font-semibold text-[var(--paper)] transition hover:opacity-80">
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
              {" "}· {me.quota.remaining}/{me.quota.cap} applications left today
              {" "}· <span title="The agent only surfaces roles that score at least this on resume fit.">min match ≥{me.profile?.minMatchScore ?? 55}</span>
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
            {/* Notifications bell — the in-app update feed. Works with no email or
                Slack configured, so it's the reliable channel for every user. */}
            <div className="relative">
              <button
                onClick={toggleNotifications}
                title="Updates from your agent"
                aria-label="Notifications"
                className="relative rounded-lg border border-border px-3 py-2.5 text-sm hover:border-brand/60 transition"
              >
                <span aria-hidden>🔔</span>
                {(me.notifications?.unread ?? 0) > 0 && (
                  <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold text-white">
                    {me.notifications!.unread > 9 ? "9+" : me.notifications!.unread}
                  </span>
                )}
              </button>
              {notifOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setNotifOpen(false)} />
                  <div className="absolute right-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface shadow-[0_10px_40px_rgba(23,20,15,0.18)]">
                    <div className="border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted">
                      Updates
                    </div>
                    <div className="max-h-[60vh] overflow-y-auto">
                      {(me.notifications?.items.length ?? 0) === 0 ? (
                        <p className="px-4 py-6 text-center text-sm text-muted">
                          No updates yet. When your agent finds or prepares matches, they show up here.
                        </p>
                      ) : (
                        me.notifications!.items.map((n) => (
                          <div key={n.id} className="border-b border-border/60 px-4 py-3 last:border-0">
                            <div className="flex items-center gap-2">
                              {n.tier === "urgent" && <span className="size-1.5 shrink-0 rounded-full bg-brand" />}
                              <span className="text-sm font-medium">{n.title}</span>
                            </div>
                            <p className="mt-0.5 whitespace-pre-line text-xs text-muted">{n.body}</p>
                            <p className="mt-1 text-[10px] text-muted/70">{new Date(n.createdAt).toLocaleString()}</p>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
            <Link
              href="/applications"
              className="rounded-lg border border-border px-4 py-2.5 text-sm font-medium hover:border-brand/60 transition"
              title="See the exact resume sent per application (interview call prep)"
            >
              Call prep ↗
            </Link>
            {isRunning ? (
              // Persistent while a run is in flight. Stays put across reloads
              // (driven by activeRun) and can't be re-clicked — no duplicate run,
              // no confusion about whether it's working.
              <button
                disabled
                title="Your agent is working — finding and preparing matches. This stays until it finishes."
                className="flex items-center gap-2 rounded-lg brand-gradient px-4 py-2.5 text-sm font-medium text-white opacity-90 cursor-progress"
              >
                <span className="size-2 rounded-full bg-white/90 pulse-dot" />
                Agent working…
              </button>
            ) : connectedCount === 0 ? (
              <button
                disabled
                onClick={() => setTab("integrations")}
                title="Connect a job platform first to run the agent"
                className="rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-muted cursor-not-allowed opacity-60"
              >
                Connect a platform first
              </button>
            ) : me.quota.remaining === 0 ? (
              <button
                disabled
                title="You've used today's applications — resets tomorrow"
                className="rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-muted cursor-not-allowed opacity-60"
              >
                Daily limit reached
              </button>
            ) : (
              <button
              onClick={() => runAgent()}
              title={connectedCount === 0 ? "Connect a job platform first" : "Find supported live matches"}
              className="press rounded-lg brand-gradient px-4 py-2.5 text-sm font-medium text-white hover:opacity-90 transition disabled:opacity-50"
            >
              Run agent
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

        {/* Welcome-back confirm: fires when the user tabs back after opening a
            listing to submit. Closes the "forgot to mark it submitted" gap. */}
        {showReturnPrompt && pendingSubmit && (
          <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-4">
            <div className="flex w-full max-w-lg items-center gap-3 rounded-xl border border-accent/50 bg-surface px-4 py-3 text-sm shadow-[0_8px_30px_rgba(23,20,15,0.18)]">
              <span className="flex-1">
                Did you submit <span className="font-medium">{pendingSubmit.label}</span>?
              </span>
              <button
                onClick={() => confirmManualSubmission(pendingSubmit.id)}
                disabled={confirmingSubmittedId === pendingSubmit.id}
                className="press rounded-md border border-accent/50 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/20 transition disabled:opacity-50"
              >
                {confirmingSubmittedId === pendingSubmit.id ? "…" : "✓ Yes, submitted"}
              </button>
              <button
                onClick={dismissReturnPrompt}
                className="rounded-md px-2 py-1.5 text-xs text-muted hover:text-foreground transition"
              >
                Not yet
              </button>
            </div>
          </div>
        )}

        {me.quota.remaining === 0 && (
          <div className="mt-5 rounded-xl border border-warn/50 bg-warn/10 px-4 py-3 text-sm">
            <span className="font-medium">
              You&apos;ve used today&apos;s {me.quota.cap} applications. The agent picks up again tomorrow.
            </span>
          </div>
        )}

        {/* banners */}
        {connectedCount === 0 && (
          <div className="mt-5 rounded-xl border border-brand/40 bg-brand/10 px-4 py-3 text-sm">
            <span className="font-medium">Connect a job platform</span>{" "}
            <span className="text-muted">so the agent can find and apply to matches for you.</span>{" "}
            <button onClick={() => setTab("integrations")} className="underline text-brand-2 ml-1">Set up integrations →</button>
          </div>
        )}
        {readyCount > 0 && (
          <div className="mt-3 flex items-center justify-between rounded-xl border border-brand/40 bg-brand/10 px-4 py-3 text-sm">
            <div>
              <span className="font-medium">
                {readyCount} match{readyCount !== 1 ? "es" : ""} matched to you.
              </span>{" "}
              <span className="text-muted">
                Open each to submit it yourself — Grindly never submits on your behalf.
              </span>{" "}
              <button onClick={() => { setTab("applications"); setFilter("matched"); }} className="underline text-brand-2 ml-1">See matched list →</button>
            </div>
            <button
              onClick={approveAllApplications}
              disabled={approvingAll}
              title="Lines up every ready match under 'To submit' and emails you the links."
              className="ml-4 shrink-0 rounded-lg border border-brand/40 px-3 py-1.5 text-xs text-brand-2 hover:bg-brand/10 transition disabled:opacity-50"
            >
              {approvingAll ? "Lining up…" : `Line up all ${readyCount}`}
            </button>
          </div>
        )}
        {readyCount === 0 && me.stats.queued > 0 && (
          <div className="mt-3 rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm text-muted">
            <span className="font-medium text-foreground">You&apos;re all caught up for today.</span>{" "}
            The agent has already found{" "}
            <span className="font-medium text-foreground">
              {me.stats.queued} more {me.stats.queued === 1 ? "role" : "roles"}
            </span>{" "}
            for you and releases a fresh batch each day. It&apos;s working — spacing
            applications out is what keeps your accounts from getting flagged. Check
            back tomorrow for the next batch.
          </div>
        )}

        {/* reconnect warnings */}
        {integrations.filter((i) => i.status === "needs_login").map((i) => (
          <div key={i.platform} className="mt-3 flex items-center justify-between rounded-xl border border-warn/40 bg-warn/10 px-4 py-2.5 text-sm text-warn">
            <span>{PLATFORM_META[i.platform]?.label ?? i.platform} login expired — reconnect to resume live applications.</span>
            <button onClick={() => setTab("integrations")} className="ml-4 shrink-0 rounded-lg border border-warn/60 px-3 py-1 text-xs hover:bg-warn/20 transition">Reconnect</button>
          </div>
        ))}

        {/* stats — plain words only. "Matched" is today's batch, due now, waiting on
            one tap. "Lined up" is the rest of the month, which the agent releases a
            day at a time; the user is told the work exists but is never handed the
            list (src/lib/pipeline.ts). We deliberately dropped the old "Avg match"
            tile: it averaged over skipped low-score rows too, so it could read "10"
            under a "min match ≥65" header — a contradiction that just confused. */}
        <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
          {([
            ["Matched", me.stats.ready, "text-foreground", "Matched to you and ready now — open and submit each one"],
            ["Lined up", me.stats.queued, "text-muted", "Found for you and waiting — the agent releases a fresh batch each day so your applications stay paced"],
            ["Applied", me.stats.applied, "text-accent", "You've submitted these"],
            ["Failed", me.stats.failed, "text-danger", "The submission didn't go through — you can retry these"],
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

            {/* The one failure that looks fine to a human. Louder than every other
                issue on this card, because if a parser can't open the file, nothing
                else about the resume matters. */}
            {resumeAts && !resumeAts.readable && (
              <div className="mb-3 rounded-lg border-2 border-danger bg-danger/10 px-3 py-2.5 text-xs text-danger">
                <div className="font-semibold">A recruiter&apos;s system can&apos;t read this resume.</div>
                <p className="mt-1">
                  Almost no text could be extracted from the file — it&apos;s most likely a
                  scan, an image, or an export with embedded fonts. It looks fine on screen
                  and arrives as a blank page. Re-export a text-based PDF and upload it
                  below before the agent sends anything.
                </p>
              </div>
            )}

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
                  : "Upload your resume below to get an AI quality score and improvement suggestions."}
                {skills.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {skills.map((s) => (
                      <span key={s} className="rounded-md bg-brand/15 px-2 py-0.5 text-xs text-brand-2">{s}</span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Resume files. Two slots, because they do different jobs: the master is
                what a recruiter receives; the .tex is the source the agent edits when
                a role needs a tailored version. With no .tex the agent sends the
                master untouched rather than rebuilding a lookalike and wrecking the
                template the college mandated. */}
            <div className="mt-6 border-t border-border pt-5">
              <div className="text-xs uppercase tracking-wide text-muted mb-3">Resume files</div>
              <div className="grid sm:grid-cols-2 gap-3">
                <ResumeSlot
                  label="Master resume"
                  hint="PDF, DOCX or TXT · this is what gets sent"
                  current={me.profile.resumeName}
                  accept=".pdf,.docx,.txt"
                  busy={uploading === "master"}
                  onPick={(f) => uploadResume(f, "master")}
                />
                <ResumeSlot
                  label="LaTeX source (optional)"
                  hint=".tex · lets the agent tailor without breaking your template"
                  current={me.profile.resumeTexName}
                  accept=".tex"
                  busy={uploading === "tex"}
                  onPick={(f) => uploadResume(f, "tex")}
                  status={me.profile.resumeTexStatus}
                  detail={me.profile.resumeTexDetail}
                />
              </div>
              <p className="mt-3 text-xs text-muted">
                Replacing your master resume re-extracts your skills and re-scores it —
                the agent uses the new one from its next run. The agent only ever edits
                the <span className="text-foreground">Skills</span> and{" "}
                <span className="text-foreground">Hobbies</span> sections of your .tex,
                and throws the edit away if it changes your page count.
              </p>
            </div>
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
              {t === "applications" && readyCount > 0 && (
                <span className="ml-1.5 rounded-full bg-warn/20 px-1.5 py-0.5 text-[10px] text-warn">{readyCount}</span>
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
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted mb-4">Limits &amp; rules</h2>
              <div className="space-y-4">
                {PROFF_FIELDS.filter((f) => f.group === "Limits & rules").map((f) => (
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
                      <label className="flex items-start gap-3 cursor-pointer">
                        {/* Knob centered with inline-flex (not absolute) so it can
                            never spill past the track and overlap the label. */}
                        <button
                          type="button"
                          role="switch"
                          aria-checked={profileForm.autoApply}
                          onClick={() => patchForm("autoApply", !profileForm.autoApply)}
                          className={`shrink-0 inline-flex h-6 w-11 items-center rounded-full px-0.5 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-brand ${profileForm.autoApply ? "bg-accent" : "bg-surface-2 border border-border"}`}
                        >
                          <span className={`size-5 rounded-full bg-white shadow-sm transition-transform ${profileForm.autoApply ? "translate-x-5" : "translate-x-0"}`} />
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
              {/* One vocabulary end to end: Matched (came due, needs your go-ahead)
                  → To submit (you opened it, confirm when done) → Applied. Same
                  words as the row badges so nothing has two names. */}
              {([
                ["all", "all"],
                ["matched", "matched"],
                ["approved", "to submit"],
                ["applied", "applied"],
                ["failed", "failed"],
                ["skipped", "skipped"],
              ] as const).map(([f, label]) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  aria-pressed={filter === f}
                  className={`rounded-md px-2.5 py-1 capitalize transition ${
                    filter === f ? "bg-surface-2 text-foreground" : "text-muted hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="text-xs text-muted mb-2">
              {filteredApps.length} result{filteredApps.length !== 1 ? "s" : ""}
              {totalPages > 1 && ` · page ${page + 1} of ${totalPages}`}
            </div>

            {apps.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-10 text-center text-muted">
                No applications yet. Connect a job platform, then hit <span className="text-foreground">Run agent</span> to find supported matches.
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
                      </div>
                      <div className="text-sm text-muted mt-0.5">{a.company}</div>
                      {/* The submit URL, in plain sight and copyable — the link
                          you open on the platform to actually apply. */}
                      {a.url && (
                        <div className="mt-1 flex items-center gap-2 min-w-0">
                          <a
                            href={a.url}
                            target="_blank"
                            rel="noreferrer"
                            title={a.url}
                            className="truncate text-xs font-mono text-brand-2 hover:underline max-w-[min(28rem,60vw)]"
                          >
                            {a.url}
                          </a>
                          <button
                            onClick={() => copyText(a.id, a.url!)}
                            title="Copy this application link"
                            className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted hover:text-foreground hover:border-brand/40 transition"
                          >
                            {copiedId === a.id ? "Copied ✓" : "Copy"}
                          </button>
                        </div>
                      )}
                      {a.reason && (
                        <div className="text-xs text-muted mt-1 truncate max-w-md" title={a.reason}>
                          {a.reason}
                        </div>
                      )}
                      {/* What they want that you don't show. Worth knowing before you
                          send it, and worth revising before the call. */}
                      {(() => {
                        const gap = parseJ<string[]>(a.missingSkills ?? "[]", []);
                        if (!gap.length) return null;
                        return (
                          <div className="mt-1.5 flex flex-wrap items-center gap-1">
                            <span className="text-[10px] uppercase tracking-wide text-muted">
                              They also want
                            </span>
                            {gap.map((s) => (
                              <span
                                key={s}
                                title="This role asks for it and your resume doesn't show it — expect to be asked."
                                className="rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[10px] text-warn"
                              >
                                {s}
                              </span>
                            ))}
                          </div>
                        );
                      })()}
                      {/* Apply Kit — resume, cover letter, and (where the platform
                          supports it) drafted screening answers, ready before you ever
                          open the form. Null fields mean the agent's next pass hasn't
                          generated it yet, or (answers only) this platform doesn't
                          support reading questions ahead of time — never a fabrication. */}
                      {a.status === "matched" && (a.coverLetterText || a.resumeVersionId) && (
                        <div className="mt-2 rounded-lg border border-border bg-surface-2 p-2.5 space-y-2">
                          <div className="text-[10px] uppercase tracking-wide text-muted">Apply kit</div>
                          {a.resumeVersionId && (
                            <a
                              href={`/api/applications/${a.id}/resume`}
                              target="_blank"
                              rel="noreferrer"
                              className="flex items-center gap-1.5 text-xs text-brand-2 hover:underline w-fit"
                            >
                              📄 Tailored resume
                            </a>
                          )}
                          {a.coverLetterText && (
                            <div>
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-xs font-medium text-foreground">Cover letter</span>
                                <button
                                  onClick={() => copyText(`${a.id}-letter`, a.coverLetterText!)}
                                  className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted hover:text-foreground hover:border-brand/40 transition"
                                >
                                  {copiedId === `${a.id}-letter` ? "Copied ✓" : "Copy"}
                                </button>
                              </div>
                              <p className="mt-1 whitespace-pre-wrap text-xs text-muted">{a.coverLetterText}</p>
                            </div>
                          )}
                          {(() => {
                            const answers = parseJ<{ q: string; a: string }[]>(a.answersJson ?? "[]", []);
                            if (!answers.length) return null;
                            return (
                              <div>
                                <div className="text-xs font-medium text-foreground mb-1">Drafted answers</div>
                                <div className="space-y-1.5">
                                  {answers.map((qa, i) => (
                                    <div key={i} className="rounded border border-border/60 p-1.5">
                                      <div className="flex items-center justify-between gap-2">
                                        <span className="text-[11px] text-muted truncate">{qa.q}</span>
                                        <button
                                          onClick={() => copyText(`${a.id}-answer-${i}`, qa.a)}
                                          className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted hover:text-foreground hover:border-brand/40 transition"
                                        >
                                          {copiedId === `${a.id}-answer-${i}` ? "Copied ✓" : "Copy"}
                                        </button>
                                      </div>
                                      <p className="mt-0.5 text-xs">{qa.a}</p>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            );
                          })()}
                          {!a.answersJson && (a.coverLetterText || a.resumeVersionId) && (
                            <p className="text-[11px] text-muted">
                              This platform doesn&apos;t support drafting screening answers ahead of time yet — you&apos;ll answer any on the form itself.
                            </p>
                          )}
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
                      {a.status === "applied" && (
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
                          onClick={() => openAndSubmit(a)}
                          disabled={approvingId === a.id || me.quota.remaining === 0}
                          title={me.quota.remaining === 0
                            ? "You've hit today's application limit — resets tomorrow."
                            : "Opens the listing so you submit it yourself. Grindly never submits on your behalf."}
                          className="press rounded-md brand-gradient px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 transition disabled:opacity-50"
                        >
                          {approvingId === a.id ? "Opening…" : "Open & submit ↗"}
                        </button>
                      )}
                      {a.status === "approved" && (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => reopen(a)}
                            title="Open the listing again"
                            className="rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:text-foreground hover:border-brand/40 transition"
                          >
                            Open again ↗
                          </button>
                          <button
                            onClick={() => confirmManualSubmission(a.id)}
                            disabled={confirmingSubmittedId === a.id}
                            title="Tap once you've submitted it on the platform."
                            className="rounded-md border border-accent/50 bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent hover:bg-accent/20 transition disabled:opacity-50"
                          >
                            {confirmingSubmittedId === a.id ? "…" : "✓ I submitted it"}
                          </button>
                        </div>
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
            <div className="mb-4 rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm">
              <p className="font-medium">Connect one or more job platforms.</p>
              <p className="mt-1 text-muted">
                You log in on the <span className="text-foreground">real platform</span> inside a
                secure window here — <span className="text-foreground">Grindly never sees, types, or stores your password</span>.
                It stays signed in so the agent can find and prepare matches for you.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {integrations.map((integration) => {
                const meta = PLATFORM_META[integration.platform];
                const isConnected = integration.status === "connected";
                const isConnecting = integration.status === "connecting" || connectingPlatform === integration.platform;
                const isPaused = integration.status === "challenge_detected";
                return (
                  <div key={integration.platform} className={`rounded-xl border p-4 transition ${
                    isConnected ? "border-accent/40 bg-accent/5" : "border-border bg-surface"
                  }`}>
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-bold rounded-md px-1.5 py-0.5 border border-current ${meta.color}`}>{meta.icon}</span>
                        <span className="font-medium">{meta.label}</span>
                      </div>
                      <span className={`text-xs rounded-full px-2 py-0.5 ${
                        isConnected ? "bg-accent/20 text-accent"
                        : isConnecting ? "bg-brand/20 text-brand-2"
                        : isPaused ? "bg-warn/20 text-warn"
                        : "bg-surface-2 text-muted"
                      }`}>
                        {isConnected ? "Connected" : isConnecting ? "Connecting…" : isPaused ? "Paused" : "Not connected"}
                      </span>
                    </div>

                    {integration.lastError && !isConnected && (
                      <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
                        {integration.lastError}
                      </div>
                    )}

                    {isConnected ? (
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs text-muted">Session ready for supported easy-apply jobs.</span>
                        <button onClick={() => disconnectPlatform(integration.platform)} className="text-xs text-muted hover:text-danger transition">Disconnect</button>
                      </div>
                    ) : isConnecting ? (
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs text-brand-2">Opening your secure login window…</span>
                        <button onClick={() => disconnectPlatform(integration.platform)} className="text-xs text-muted hover:text-danger transition">Cancel</button>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <p className="text-xs text-muted">
                          Log in yourself and handle any OTP or CAPTCHA normally. Grindly stores only the resulting browser session.
                        </p>
                        <button
                          onClick={() => connectPlatform(integration.platform)}
                          disabled={connectingPlatform !== null}
                          className="w-full press rounded-lg brand-gradient px-3 py-2 text-sm font-medium text-white hover:opacity-90 transition disabled:opacity-50"
                        >
                          Connect {meta.label}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

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
                <li>Connect any supported platform above and log in yourself in the live browser window.</li>
                <li>Once connected, the agent reuses that session to log in on our server.</li>
                <li>Click <strong>Run agent</strong> to find matches. External and unsupported complex applications are skipped.</li>
                <li>Review each prepared application and tap <strong>Approve</strong> to submit it.</li>
                <li>The agent sends up to <strong>{cap}</strong> applications/day across connected platforms.</li>
              </ol>
            </div>

            {/* ── DANGER ZONE ── self-serve account deletion. Kept visually
                separated and behind a browser confirm so it's never a stray tap. */}
            <div className="mt-5 rounded-xl border border-danger/40 bg-danger/5 p-4">
              <p className="font-medium text-danger mb-1">Delete account</p>
              <p className="text-sm text-muted mb-3">
                Permanently erases your profile, resumes, and every application record.
                This cannot be undone.
              </p>
              <button
                onClick={deleteAccount}
                className="press rounded-lg border-2 border-danger px-4 py-2 text-sm font-medium text-danger hover:bg-danger/10 transition"
              >
                Delete my account
              </button>
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

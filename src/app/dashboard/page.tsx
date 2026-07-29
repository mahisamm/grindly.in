"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Logo } from "@/components/Brand";
import { CountUp } from "@/components/Motion";
import SupportChat from "@/components/SupportChat";
import { PROFF_FIELDS, CONTACT_FIELDS } from "@/lib/proffQuestions";
import ChoiceField from "@/components/ChoiceField";
import { normalizePlan } from "@/lib/plans";
import { EMPLOYER_CHANNELS } from "@/lib/applyPolicy";

// @novnc/novnc touches `window`/browser globals at module load time — a
// static import crashes Next's server-side prerender of this page ("window
// is not defined"), even though this component is only ever mounted in the
// browser. ssr: false keeps it out of the server bundle entirely.

// A submission the user opened but hasn't confirmed yet, kept in localStorage so
// the "Did you submit it?" prompt survives a reload, a closed tab, or coming back
// tomorrow. Same-day TTL: past that we'd be asking about something the user can
// no longer remember accurately, and a wrong "yes" both burns apply quota and
// poisons the interview-rate denominator.
const PENDING_SUBMIT_KEY = "grindly_pending_submit";
const PENDING_SUBMIT_TTL_MS = 24 * 60 * 60 * 1000;

// Extensions alone are not enough in a file picker: Android's Drive/Files
// provider and some iOS pickers match on MIME type and grey out the user's own
// PDF when only extensions are listed — the upload "fails" with no request ever
// being made. Mirrors the onboarding page's list.
const RESUME_ACCEPT_ATTR = [
  ".pdf", ".docx", ".txt",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
].join(",");

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
  // Where this application is actually delivered, decided by agent/resolver.py.
  // "google_form" | "email" | "ats" mean an employer's own intake, where the
  // candidate holds no account — those the agent can send unattended.
  // "platform" means the board itself, and there the tier decides: Tier B is a
  // board the user connected, which the agent may submit; Tier C still needs
  // their own browser. Null on rows banked before routing shipped.
  applyChannel: string | null;
  applyTier: string | null;
  applyTarget: string | null;
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
  // ATS-optimized variant generation status:
  // null | generating | ready | no_gain | failed | error
  resumeVariantStatus: string | null;
  resumeVariantDetail: string | null;
  // The facts screening forms ask for. Nullable to the last one: every single
  // field here starts empty on purpose (see DEFAULTS in lib/proffQuestions) —
  // a plausible default would be a fact invented on the user's behalf and then
  // stated to an employer under their name.
  degree: string | null;
  college: string | null;
  gradYear: number | null;
  class12Percent: number | null;
  class10Percent: number | null;
  availability: string | null;
  hoursPerWeek: number | null;
  willingToRelocate: string | null;
  workAuthorization: string | null;
  needsSponsorship: string | null;
  expectedStipend: number | null;
  currentSalary: string | null;
  previousInternship: string | null;
  noticePeriod: string | null;
  currentLocation: string | null;
  dateOfBirth: string | null;
  nationality: string | null;
  country: string | null;
  gender: string | null;
  differentlyAbled: string | null;
  linkedinUrl: string | null;
  githubUrl: string | null;
  portfolioUrl: string | null;
};

// One AI-optimized, compiled, measured-higher-scoring version of the master resume.
type ResumeVariant = {
  id: string;
  rank: number;
  label: string;
  score: number;
  grade: string;
  baselineScore: number;
  changes: string[];
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
    hasAccess?: boolean;
    role?: string;
    slackConnected: boolean;
    slackUserId: string | null;
    internshalaConnected: boolean;
    gmailConnected: boolean;
    gmailScanEnabled: boolean;
    gmailScanBeta?: boolean;
    gmailScanInterest?: boolean;
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
  // What the agent is allowed to send on this deploy. The dashboard used to state
  // "you always submit it yourself" as an absolute; that is true in shadow mode
  // and a lie in live mode, so the copy reads this instead of hardcoding either.
  autoApply?: {
    mode: "off" | "shadow" | "live";
    sendsAny: boolean;
  };
  quota: {
    kind: "trial" | "daily";
    cap: number;
    used: number;
    remaining: number;
  };
  integrations: Integration[];
  resumeVariants?: ResumeVariant[];
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
  name: string;
  phone: string;
  gpa: string;
  reportChannel: string;
  maxPerDay: number;
  degree: string;
  college: string;
  gradYear: number;
  class12Percent: number;
  class10Percent: number;
  availability: string;
  hoursPerWeek: number;
  willingToRelocate: string;
  workAuthorization: string;
  needsSponsorship: string;
  expectedStipend: number;
  currentSalary: string;
  previousInternship: string;
  noticePeriod: string;
  currentLocation: string;
  dateOfBirth: string;
  nationality: string;
  country: string;
  gender: string;
  differentlyAbled: string;
  linkedinUrl: string;
  githubUrl: string;
  portfolioUrl: string;
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
  // The agent submitted but the page gave no confirmation. Not a success (that
  // would overstate what happened) and not a failure (something probably did
  // send) — the user needs to look. It used to fall through to the default and
  // render the raw string "needs_review" with no explanation and no action.
  needs_review: "bg-warn/15 text-warn",
};

// One consistent vocabulary the user can actually model:
//   Matched → (you open + submit on the platform) → To submit → (you confirm) → Applied
//
// That path is now the EXCEPTION, not the rule. Anything the agent can deliver
// itself — a company form, an HR inbox, a careers portal, Internshala — is sent
// during the run and lands on Applied without stopping here. A row only reaches
// Matched when the agent declined to send it, and its `reason` says why.
const STATUS_LABEL: Record<string, string> = {
  applied:  "Applied",
  approved: "To submit",
  matched:  "Matched",
  skipped:  "Skipped",
  failed:   "Failed",
  needs_review: "Check it",
};

// Every status the user can be shown needs a plain-English gloss. A badge on its
// own tells someone what bucket a row is in, never what to do about it.
const STATUS_HELP: Record<string, string> = {
  applied: "This one went in.",
  approved: "Lined up. The row says whether the agent sends it or you do.",
  matched: "Found for you — this one needs your tap to send.",
  skipped: "Not sent — the reason is on the row.",
  failed: "Didn't go through. Open it and send it yourself.",
  needs_review: "Sent, but the site didn't confirm it. Open it and check before re-sending.",
};

/** Did the agent deliver this itself, with no action from the user?
 *
 *  A row counts as agent-sent because of its own destination, not because of a
 *  mode flag — the deploy can change after the row was filed.
 *
 *  The channel list is imported rather than hand-copied. This function is a
 *  mirror of src/lib/applyPolicy.ts and it has already drifted once: "ats" was
 *  added there and silently not here, so an application the agent really had
 *  sent showed up as a plain "Applied" and went uncounted.
 *
 *  Tier B is a separate check. The agent submits those on the board the user
 *  connected, so their channel is "platform" and the employer-channel test
 *  above never sees them. */
function sentByAgent(a: App): boolean {
  if (a.status !== "applied") return false;
  if ((EMPLOYER_CHANNELS as readonly string[]).includes(a.applyChannel ?? "")) return true;
  return a.applyTier === "B";
}

/** The single "what should I do next" strip.
 *
 *  One component, one at a time. The dashboard previously composed this state out
 *  of six independently-conditioned boxes that could all render together, which
 *  left the user to work out the priority order themselves.
 */
function Banner({
  tone, title, body, action, secondary,
}: {
  tone: "brand" | "warn" | "muted";
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
  secondary?: { label: string; onClick: () => void; disabled?: boolean };
}) {
  const skin =
    tone === "brand" ? "border-brand/40 bg-brand/10"
    : tone === "warn" ? "border-warn/40 bg-warn/10"
    : "border-border bg-surface-2";
  return (
    <div className={`mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${skin}`}>
      <div className="min-w-0">
        <span className="font-medium">{title}</span>
        {body && <span className="text-muted"> {body}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {secondary && (
          <button
            onClick={secondary.onClick}
            disabled={secondary.disabled}
            className="rounded-lg border border-border px-3 py-1.5 text-xs hover:border-brand/50 transition disabled:opacity-50"
          >
            {secondary.label}
          </button>
        )}
        {action && (
          <button
            onClick={action.onClick}
            className="press rounded-lg brand-gradient px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 transition"
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}

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


/**
 * A stored 0 in an eligibility field means "never answered", not "zero".
 *
 * Every numeric fact starts at 0 as its empty marker (see DEFAULTS in
 * lib/proffQuestions, and agent/questions.py, which reads 0 as no-fact-held and
 * refuses the question). Rendering that marker as the digit 0 told the user
 * their class 12 percentage was on file and was 0% — so the one screen that
 * exists to show them what is missing showed it as answered instead.
 *
 * Deliberately NOT applied to stipendMin or minMatchScore, where 0 is a real
 * setting the user can mean.
 */
function blankIfUnset(v: unknown): string {
  return v === 0 || v === null || v === undefined ? "" : String(v);
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
    // `name` lives on User, not Profile — profileToForm only sees the
    // profile row, so this is filled in by the caller (load(), from
    // data.user.name) and defaults blank here for the rare direct caller.
    name: "",
    phone: p.phone || "",
    gpa: p.gpa != null ? String(p.gpa) : "8.0",
    reportChannel: p.reportChannel || "email",
    // 0 = never set = "use my plan's allowance" (worker._cap_for reads it the
    // same way). Not defaulted to 5 here: that would re-cap every account that
    // has never opened the setting.
    maxPerDay: p.maxPerDay ?? 0,
    // Empty, never defaulted. `|| ""` and `?? 0` here both mean "the user has
    // not told us" — the same thing agent/questions.py reads as no-fact-held,
    // which is what makes it refuse the question instead of guessing.
    degree: p.degree || "",
    college: p.college || "",
    gradYear: p.gradYear ?? 0,
    class12Percent: p.class12Percent ?? 0,
    class10Percent: p.class10Percent ?? 0,
    availability: p.availability || "",
    hoursPerWeek: p.hoursPerWeek ?? 0,
    willingToRelocate: p.willingToRelocate || "",
    workAuthorization: p.workAuthorization || "",
    needsSponsorship: p.needsSponsorship || "",
    expectedStipend: p.expectedStipend ?? 0,
    currentSalary: p.currentSalary || "",
    previousInternship: p.previousInternship || "",
    noticePeriod: p.noticePeriod || "",
    currentLocation: p.currentLocation || "",
    dateOfBirth: p.dateOfBirth || "",
    nationality: p.nationality || "",
    country: p.country || "",
    gender: p.gender || "",
    differentlyAbled: p.differentlyAbled || "",
    linkedinUrl: p.linkedinUrl || "",
    githubUrl: p.githubUrl || "",
    portfolioUrl: p.portfolioUrl || "",
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
          <button type="button" onClick={() => onChange(value.filter((x) => x !== t))} aria-label={`remove ${t}`} className="min-h-0 leading-none text-muted hover:text-danger">×</button>
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
    return { kind: "info", text: "Your agent's automatic daily run stays inside 9am–9pm IST — but you can start one any time. Tap Run now to go immediately." };
  }
  if (x.error || (x.message && x.ready == null && x.matched == null && x.applied == null)) {
    // Say what actually went wrong. This used to fall through to "Connect a job
    // platform" for EVERY worker error, because no agent result ever sets
    // `message` — so a missing resume, an unreadable PDF or a dead run all told
    // the user to do the one thing this deploy deliberately made optional
    // (api/agent/run no longer requires a connected platform at all).
    //
    // Codes come from agent/worker.py: run_for_user / analyze_only.
    const ERRORS: Record<string, string> = {
      no_resume: "Upload your resume first — the agent scores every match against it.",
      "no resume": "Upload your resume first — the agent scores every match against it.",
      resume_unreadable:
        "We couldn't read any text from your resume — it may be a scanned image. Upload a text-based PDF or DOCX.",
      no_platforms_connected:
        "No job platform is connected. Connect one, or just run again — discovery works without it.",
      "no user": "Your account could not be loaded. Sign out and back in, and contact support if it persists.",
    };
    const known = x.error ? ERRORS[x.error] : undefined;
    return {
      kind: "info",
      text:
        known ??
        x.message ??
        (x.error
          ? `The run stopped: ${x.error}. Try again — if it repeats, tell us from the support chat.`
          : "The run didn't complete. Try again — if it repeats, tell us from the support chat."),
    };
  }
  const matched = x.matched ?? 0;
  const ready = x.ready ?? 0;
  const applied = x.applied ?? 0;
  const failed = x.failed ?? 0;
  const pipeline = x.pipeline ?? 0;
  if (matched === 0 && applied === 0 && ready === 0) {
    return {
      kind: "info",
      text: "No new matches this run — but your agent stays on and runs again automatically every day, so there's nothing to press. Want more sooner? Widen your domains/locations or lower the match threshold in Profile.",
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

type Autopilot = {
  state: "paused" | "setup_incomplete" | "active";
  readiness: { ready: boolean; missing: string[] };
  today: {
    submitted: number; limit: number; remaining: number;
    reserved?: number; attempted: number; date: string; timezone: string;
  };
  queued: number;
  lifetimeSubmitted: number;
  timeline: {
    id: string; jobTitle: string; company: string; url: string | null;
    status: string; appliedAt: string | null; applyChannel: string | null;
    applyTier: string | null; reason: string | null;
  }[];
  actionNeeded: {
    id: string; url: string; host: string;
    reason: string | null; says: string; at: string;
  }[];
  browser: { connected: boolean; label?: string | null; lastSeen?: string | null };
};

export default function Dashboard() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  // Autopilot panel data. Kept separate from `me` because every number in it is
  // derived server-side from what actually happened (the reservation ledger and
  // application rows), never from optimistic UI state — a dashboard that
  // inflates "applied" is lying to someone about their own job search.
  const [autopilot, setAutopilot] = useState<Autopilot | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState<"profile" | "applications" | "reports">("applications");
  const [filter, setFilter] = useState<string>("all");
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
  // Neither pollRun's nor connectPlatform's poll loop stopped itself on
  // unmount (e.g. navigating to /applications mid-run) — the old closure kept
  // firing fetches every 2-2.5s, and returning to /dashboard later started a
  // second, independent poll for the same run/connect attempt. This flag —
  // and connectAbort, reused below — is checked at the top of each loop step.
  const unmounted = useRef(false);
  useEffect(() => {
    return () => {
      unmounted.current = true;
      connectAbort.current = true;
    };
  }, []);
  const [page, setPage] = useState(0);
  const [profileForm, setProfileForm] = useState<ProfileForm | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [approvingAll, setApprovingAll] = useState(false);
  const [confirmingSubmittedId, setConfirmingSubmittedId] = useState<string | null>(null);
  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null);
  // Row whose submit URL was just copied — flips the button to "Copied ✓" briefly.
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Is the browser extension installed in THIS browser? Its content script stamps
  // data-grindly-extension on <html>. When present, the Apply Kit shows the
  // one-click auto-fill hint; when absent, an optional install nudge. Purely a UI
  // adaptation — the kit (copy/paste) works fully either way.
  const [extInstalled, setExtInstalled] = useState(false);
  useEffect(() => {
    const check = () => setExtInstalled(!!document.documentElement.getAttribute("data-grindly-extension"));
    check();
    // The content script may attach just after mount; re-check briefly.
    const t = setTimeout(check, 800);
    return () => clearTimeout(t);
  }, []);
  // The application the user just opened to submit on the platform. When they
  // switch back to this tab we surface a one-tap "Did you submit it?" prompt so
  // the loop closes even if they forget to come back and confirm.
  //
  // Mirrored to localStorage (see PENDING_SUBMIT_KEY below): this used to be
  // in-memory only, so a user who submitted on Internshala, got pulled into its
  // "recommended for you" flow, and came back an hour later (or reloaded) was
  // never asked — their application sat at `approved` forever and the Applied
  // count under-reported. Reported by a beta user, 2026-07-23.
  const [pendingSubmit, setPendingSubmit] = useState<{ id: string; label: string } | null>(null);
  const [showReturnPrompt, setShowReturnPrompt] = useState(false);
  // "Not yet" snooze — keeps the pending record alive without re-prompting on
  // every tab switch. A ref, not state: changing it must not re-run the effect.
  const snoozeUntilRef = useRef(0);
  const [notifOpen, setNotifOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [analyzingResume, setAnalyzingResume] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [usingVariant, setUsingVariant] = useState<string | null>(null);
  const [uploading, setUploading] = useState<"master" | "tex" | null>(null);
  const [editingSkills, setEditingSkills] = useState(false);
  // Resume Intelligence is reference material, not the daily job — collapsed by
  // default so the matches list isn't pushed below the fold on every visit.
  const [resumePanelOpen, setResumePanelOpen] = useState(false);
  const [skillsDraft, setSkillsDraft] = useState<string[]>([]);
  const [skillsSaving, setSkillsSaving] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [surveyRating, setSurveyRating] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err" | "info"; text: string } | null>(null);
  // Account-deletion modal: open state, the typed-confirmation text, and an
  // in-flight guard so the destructive button can't be double-fired.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  // In-app AI support chat modal.
  const [supportOpen, setSupportOpen] = useState(false);
  // True after a non-401 /api/me failure (500, network throw). Distinguishes a real
  // server problem from a genuine logged-out state so a transient blip doesn't render
  // "Not logged in." to a user who very much is.
  const [loadError, setLoadError] = useState(false);

  // Autopilot numbers come from their own endpoint (the reservation ledger +
  // application rows). Failure here must never blank the dashboard, so a bad
  // response leaves the panel on its last-good values rather than zeroing it.
  const loadAutopilot = useCallback(async () => {
    const a = await fetch("/api/autopilot")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (a && !a.error) setAutopilot(a as Autopilot);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/me");
      if (res.status === 401) {
        router.replace("/login");
        return;
      }
      if (!res.ok) {
        // Transient server error. Keep the last-good `me` (a poll blip must not
        // wipe the screen); surface a retry instead of falsely claiming logout.
        setLoadError(true);
        return;
      }
      const data = await res.json() as Me;
      loadAutopilot();
      // Gated beta: an unapproved account never reaches the app UI. Use the
      // server's owner-aware verdict (honors OWNER_EMAIL); fall back to the old
      // derivation only if an older payload lacks the field.
      const allowed = data.user.hasAccess ?? (data.user.role === "admin" || data.user.accessStatus === "approved");
      if (!allowed) {
        router.replace("/waitlist");
        return;
      }
      setMe(data);
      setLoadError(false);
      setProfileForm((prev) => {
        if (!data.profile) return prev;
        const fresh = { ...profileToForm(data.profile), name: data.user.name || "" };
        if (!prev) return fresh;
        // The worker auto-fills phone/GPA off the resume AFTER this form was first
        // loaded (analysis runs in the background). Without this, those values land
        // in the DB and /api/me but never reach the fields the user is looking at —
        // "it's not filling anything." Adopt the server value ONLY where the user
        // hasn't set it locally, so an edit in progress is never clobbered. Mirrors
        // db.update_contact's "fill blanks only" rule (8.0 GPA = unset placeholder).
        return {
          ...prev,
          name: prev.name.trim() ? prev.name : fresh.name,
          phone: prev.phone.trim() ? prev.phone : fresh.phone,
          gpa: prev.gpa && prev.gpa !== "8.0" ? prev.gpa : fresh.gpa,
        };
      });
    } catch {
      // Network throw (offline / DNS). Same handling as a non-ok response.
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [router, loadAutopilot]);

  useEffect(() => {
    // Paused entirely while the remote-login viewer is open — including the
    // immediate load(). Two reasons: every tick re-renders the tree that hosts
    // the live VNC canvas (what users saw as the login window flickering), and
    // on a 1-vCPU host it competes with the connect container streaming that
    // very screen. Nothing here is worth refreshing while the user is staring at
    // a login window; the connect poll calls load() the moment it connects, and
    // this effect re-runs (fetching once) as soon as the viewer closes.
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

  // When the user comes back after opening a listing to submit, ask them to
  // confirm — this is what closes the "opened it, never came back to mark it"
  // gap that left applications stuck and skewed the response-rate metric.
  //
  // Three triggers, not one: `focus` alone missed the common cases — a phone
  // browser switching tabs fires `visibilitychange` without `focus`, and a
  // back-navigation from a bfcache'd page fires only `pageshow`.
  useEffect(() => {
    if (!pendingSubmit) return;
    const show = () => {
      if (document.hidden || Date.now() < snoozeUntilRef.current) return;
      setShowReturnPrompt(true);
    };
    window.addEventListener("focus", show);
    window.addEventListener("pageshow", show);
    document.addEventListener("visibilitychange", show);
    return () => {
      window.removeEventListener("focus", show);
      window.removeEventListener("pageshow", show);
      document.removeEventListener("visibilitychange", show);
    };
  }, [pendingSubmit]);

  // Restore a pending confirmation across reloads/new sessions. Anything older
  // than PENDING_SUBMIT_TTL_MS is dropped — asking "did you submit this?" about
  // a listing from last week invites a wrong yes, and a wrong yes burns quota
  // and corrupts the interview-rate denominator.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PENDING_SUBMIT_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { id?: string; label?: string; at?: number };
      if (!saved?.id || !saved.label || !saved.at || Date.now() - saved.at > PENDING_SUBMIT_TTL_MS) {
        localStorage.removeItem(PENDING_SUBMIT_KEY);
        return;
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect -- rehydrate from storage on mount
      setPendingSubmit({ id: saved.id, label: saved.label });
      setShowReturnPrompt(true); // they are already back — ask now
    } catch { /* private mode / corrupt value — the in-memory path still works */ }
  }, []);

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
    // The response used to be discarded, so a refused resume (access still
    // pending) looked identical to a successful one: the toggle snapped back on
    // the next poll with nothing said. Say what happened either way.
    try {
      const r = await fetch("/api/agent/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        setNotice({ kind: "err", text: j.error || "Couldn't change that just now — try again." });
      } else {
        setNotice({
          kind: "ok",
          text: action === "pause"
            ? "Agent paused. It won't search or apply until you turn it back on."
            : "Agent is back on. It'll search for you again from the next run.",
        });
      }
    } catch {
      setNotice({ kind: "err", text: "Couldn't reach the server — check your connection." });
    }
    load();
  }

  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/login";
  }

  // Executes the deletion. The guard rails live in the modal (typed "DELETE"
  // confirmation + spelled-out consequences); this only runs once the user has
  // cleared them, and the API still independently requires { confirm:true }.
  async function deleteAccount() {
    setDeleting(true);
    const res = await fetch("/api/account", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    if (res.ok) {
      window.location.href = "/login";
    } else {
      setDeleting(false);
      setDeleteOpen(false);
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
    let consecutiveErrors = 0;
    const step = async () => {
      if (unmounted.current) { pollingRunId.current = null; return; }
      try {
        const r = await fetch(`/api/agent/run?id=${runId}`);
        const s = await r.json();
        if (unmounted.current) { pollingRunId.current = null; return; }
        consecutiveErrors = 0;
        if (s.status === "done" || s.status === "failed" || s.status === "cancelled") {
          pollingRunId.current = null;
          finishedRunId.current = runId;
          setRunning(false);
          if (s.status === "done") setNotice(describeRun(s.result || {}));
          else if (s.status === "failed") setNotice({ kind: "err", text: `Agent run failed: ${s.error || "unknown error"}. Try again — if it keeps failing, reach out and we'll dig in.` });
          load();
          return;
        }
        // Still queued/running. Stop polling after the watchdog window, but drop
        // the local optimistic flag so the button isn't frozen forever: past this
        // point `activeRun` from /api/me is the sole source of "working", and it
        // clears when the run finishes (or ages out, see /api/me's staleness
        // guard). Without this a run longer than the window left `running` stuck
        // true after activeRun cleared, freezing the CTA until a reload.
        //
        // Say so, too. Giving up silently looked identical to a run that had
        // finished and found nothing — the spinner stopped, the list didn't move,
        // and there was no way to tell "still working" from "done, no matches".
        if (Date.now() - started > 240_000) {
          pollingRunId.current = null;
          setRunning(false);
          setNotice({
            kind: "info",
            text: "Your agent is still working — a full run can take a while. This page updates on its own; nothing is stuck.",
          });
          load();
          return;
        }
        setTimeout(step, 2500);
      } catch {
        if (unmounted.current) { pollingRunId.current = null; return; }
        // A blip is not an ending. This used to abandon the poll on the first
        // failed fetch WITHOUT clearing `running`, so one dropped request left
        // the header on "Agent working…" until a reload — for a run that had
        // very likely already finished.
        consecutiveErrors += 1;
        if (consecutiveErrors >= 4) {
          pollingRunId.current = null;
          setRunning(false);
          setNotice({ kind: "err", text: "Lost contact with the server while your agent was running. Reload to see where it got to." });
          load();
          return;
        }
        setTimeout(step, 2500 * consecutiveErrors);   // back off, keep watching
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

  // Closing the login viewer cancels the attempt: stop the poll loop from
  // re-opening it, drop the local UI state, and tell the server to tear down
  // the remote-browser session (best-effort) so a half-finished login isn't
  // left running for the full timeout.


  async function saveProfile() {
    if (!profileForm) return;
    setProfileSaving(true);
    const body = {
      ...profileForm,
      gpa: parseFloat(profileForm.gpa) || 8.0,
    };
    // try/finally: an unhandled throw skipped setProfileSaving(false) and left
    // the Save button spinning and disabled until a reload, with the user's
    // edits still unsaved and nothing on screen saying so.
    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setProfileSaved(true);
        setTimeout(() => setProfileSaved(false), 3000);
        load();
      } else {
        setNotice({ kind: "err", text: "Failed to save profile. Please try again." });
      }
    } catch {
      setNotice({ kind: "err", text: "Network error — your changes weren't saved. Try again." });
    } finally {
      setProfileSaving(false);
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

  /** Kick off ATS-optimized variant generation (the "3 better resumes" feature).
   *  Server enqueues the worker's `optimize` mode; we poll the run like analyze.
   *  Generation is several LLM calls + LaTeX compiles, so the timeout is generous
   *  and load() at the end pulls in the finished variants + status. */
  async function optimizeResume() {
    setOptimizing(true);
    try {
      const res = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optimize: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setOptimizing(false);
        setNotice({ kind: "err", text: data.error || "Couldn't start optimization. Try again." });
        return;
      }
      load(); // flip the card to "generating" immediately
      const runId: string | null = data.runId ?? null;
      if (!runId) { setTimeout(() => { setOptimizing(false); load(); }, 8000); return; }

      const started = Date.now();
      const poll = async () => {
        try {
          const r = await fetch(`/api/agent/run?id=${runId}`);
          const s = await r.json();
          if (s.status === "done" || s.status === "failed") {
            setOptimizing(false); load(); return;
          }
          if (Date.now() - started > 240_000) { setOptimizing(false); load(); return; }
          setTimeout(poll, 3000);
        } catch { setOptimizing(false); load(); }
      };
      setTimeout(poll, 3000);
    } catch {
      setOptimizing(false);
      setNotice({ kind: "err", text: "Couldn't start optimization. Try again." });
    }
  }

  /** Promote one optimized variant to the master resume. Server copies the PDF,
   *  resets derived skills/score, and re-analyzes — load() shows the new state. */
  async function selectResumeVariant(v: ResumeVariant) {
    setUsingVariant(v.id);
    try {
      const res = await fetch(`/api/resume/variants/${v.id}/use`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice({ kind: "err", text: data.error || "Couldn't switch to this version." });
        return;
      }
      setNotice({ kind: "ok", text: "Switched to the optimized resume — re-analyzing now." });
      load();
    } catch {
      setNotice({ kind: "err", text: "Couldn't switch to this version." });
    } finally {
      setUsingVariant(null);
    }
  }

  /** Replace the master resume or the LaTeX source. A new master clears the
   *  skills/score derived from the old one server-side, so `load()` afterwards is
   *  what makes the re-analysis visible. */
  async function uploadResume(file: File, kind: "master" | "tex") {
    // Catch the two rejections the server would issue anyway, before spending a
    // slow mobile upload on them.
    const limit = kind === "tex" ? 512 * 1024 : 5 * 1024 * 1024;
    if (file.size > limit) {
      setNotice({
        kind: "err",
        text: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${kind === "tex" ? "512 KB" : "5 MB"}.`,
      });
      return;
    }
    if (file.size === 0) {
      setNotice({ kind: "err", text: "That file is empty — pick the actual resume file." });
      return;
    }
    setUploading(kind);
    const body = new FormData();
    body.append("file", file);
    // 2 minutes, and a real timeout rather than hanging forever: a stalled
    // upload with no feedback is the failure mode users report as "it doesn't work".
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120_000);
    const res = await fetch("/api/resume", { method: "POST", body, signal: ctrl.signal }).catch(() => null);
    clearTimeout(timer);
    setUploading(null);
    if (!res || !res.ok) {
      const msg = res ? ((await res.json().catch(() => ({}))) as { error?: string }).error : null;
      setNotice({
        kind: "err",
        text: msg || "Couldn't upload that file — your connection may have dropped. Try again.",
      });
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
    // Open a BLANK tab synchronously (inside the click gesture, so it isn't
    // popup-blocked) and keep the handle. window.open returns null when
    // noopener/noreferrer is passed — which is why the old close-on-failure was
    // dead code that leaked a stray tab on a 402. We navigate it ourselves once
    // approve succeeds, severing the opener first so the listing can't tabnab us.
    // Only ever navigate to a real http(s) listing — never a javascript:/data:
    // URL, since the blank tab inherits our origin and would run it as us. a.url
    // is agent-scraped, so treat anything non-http like a no-link row.
    const safeUrl = a.url && /^https?:\/\//i.test(a.url) ? a.url : null;
    const tab = safeUrl ? window.open("about:blank", "_blank") : null;
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
    if (tab && safeUrl) {
      try { tab.opener = null; } catch { /* cross-origin already */ }
      tab.location.replace(safeUrl);
    }
    rememberPendingSubmit(a.id, `${a.jobTitle} — ${a.company}`);
    if (!safeUrl) {
      setNotice({ kind: "info", text: "This one has no direct link — open it from your job platform, then confirm below." });
    }
    load();
  }

  async function reopen(a: App) {
    if (a.url) window.open(a.url, "_blank", "noopener,noreferrer");
    rememberPendingSubmit(a.id, `${a.jobTitle} — ${a.company}`);
  }

  async function approveAllApplications() {
    setApprovingAll(true);
    const res = await fetch("/api/applications/approve-all", { method: "POST" }).catch(() => null);
    setApprovingAll(false);
    if (!res) {
      setNotice({ kind: "err", text: "Couldn't reach the server — check your connection and try again." });
      return;
    }
    const body = (await res.json().catch(() => ({}))) as {
      approved?: number; agentWillSend?: number; error?: string;
    };
    if (!res.ok) {
      // A 402 here is the daily cap, not a transient failure. Reporting "please
      // try again" made a hard limit look like a glitch, and users retried it.
      setNotice({
        kind: "err",
        text: body.error || "Couldn't prepare those applications — please try again.",
      });
      load();
      return;
    }
    // Report what the SERVER approved, not how many were on screen. The cap can
    // approve fewer than the list shows, and claiming the larger number sent
    // people looking for applications that were never lined up.
    const n = body.approved ?? 0;
    const byAgent = body.agentWillSend ?? 0;
    const byUser = Math.max(0, n - byAgent);
    setNotice({
      kind: "ok",
      text: n === 0
        ? "Nothing new to line up right now."
        : byAgent > 0 && byUser > 0
          ? `Lined up ${n}. The agent sends ${byAgent} itself; ${byUser} need your tap under "To submit".`
          : byAgent > 0
            ? `Lined up ${n} — the agent sends ${n === 1 ? "it" : "them"} itself. Nothing for you to do.`
            : `Lined up ${n} to submit — each carries its link, and we emailed you the list. Open the "To submit" tab.`,
    });
    load();
  }

  // Remember (and persist) the listing the user just opened, so the confirm
  // prompt still finds them after a reload or a long detour on the platform.
  function rememberPendingSubmit(id: string, label: string) {
    setPendingSubmit({ id, label });
    try {
      localStorage.setItem(PENDING_SUBMIT_KEY, JSON.stringify({ id, label, at: Date.now() }));
    } catch { /* private mode — in-memory prompt still works this session */ }
  }

  function clearPendingSubmit() {
    setPendingSubmit(null);
    setShowReturnPrompt(false);
    try { localStorage.removeItem(PENDING_SUBMIT_KEY); } catch {}
  }

  // The UI now asks explicitly with a Yes/No prompt, so no native confirm() —
  // callers only reach here when the user has said they submitted it.
  async function confirmManualSubmission(id: string) {
    setConfirmingSubmittedId(id);
    if (pendingSubmit?.id === id) clearPendingSubmit();
    const res = await fetch("/api/applications/submitted", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => null);
    setConfirmingSubmittedId(null);
    // 404 = this one is no longer awaiting confirmation (already recorded, or
    // confirmed from another device). A restored prompt hitting that is normal,
    // not an error worth alarming the user about.
    if (res && res.status === 404) { load(); return; }
    if (!res || !res.ok) {
      setNotice({ kind: "err", text: "Couldn't record that submission — please try again." });
      return;
    }
    setNotice({ kind: "ok", text: "Submission recorded. Tell us the outcome here later — it's how we know the agent works." });
    load();
  }

  // Put a stopped task back in the queue. Nothing requeues `awaiting_human`
  // automatically — on purpose, since a task that might have submitted must
  // never be re-run on its own — so without this a queue of stopped tasks is
  // simply dead, and the user has cleared the CAPTCHA for nothing.
  async function retryTask(id: string) {
    setRetryingTaskId(id);
    const res = await fetch(`/api/autopilot/tasks/${id}/retry`, { method: "POST" })
      .catch(() => null);
    setRetryingTaskId(null);
    if (res && res.status === 409) {
      // Refused because a second attempt could duplicate a real application.
      // Say which, rather than a generic failure the user would just re-click.
      const why = await res.json().catch(() => ({}));
      setNotice({
        kind: "ok",
        text: why?.error === "already_applied"
          ? "That one already reached the employer — Grindly won't send it twice."
          : "That task is already running or finished.",
      });
      loadAutopilot();
      return;
    }
    if (!res || !res.ok) {
      setNotice({ kind: "err", text: "Couldn't queue that again — please try once more." });
      return;
    }
    setNotice({ kind: "ok", text: "Queued again. Your browser will pick it up on the next check." });
    loadAutopilot();
  }

  // "Not yet" — hide the bar but KEEP the pending record, so the prompt comes
  // back later instead of being lost. Dropping it here is what let a genuinely
  // submitted application stay uncounted forever after one stray tap. Snoozed
  // for 10 minutes so it doesn't re-nag on every tab switch in between.
  function dismissReturnPrompt() {
    setShowReturnPrompt(false);
    snoozeUntilRef.current = Date.now() + 10 * 60 * 1000;
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




  // Opening "Profile & settings" from the account menu should feel like landing on
  // a fresh page — jump to the top so the user isn't dropped mid-scroll into a
  // long dashboard. Paired with hiding the home content below.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (tab === "profile") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [tab]);
  // Success toasts (platform/Gmail/Slack "connected") are transient confirmations,
  // so auto-dismiss them — they should read as a popup, not a standing banner.
  // Errors and info (run outcomes, "no matches — widen domains") persist until
  // dismissed so the user can actually read them.
  useEffect(() => {
    if (typeof window === "undefined" || notice?.kind !== "ok") return;
    const t = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(t);
  }, [notice]);


  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center text-muted">
        Loading dashboard…
      </main>
    );
  }

  if (!me) {
    // Two very different states share this screen: a real server error (loadError)
    // vs. genuinely no session. Never tell a logged-in user they're logged out.
    return (
      <main className="grid-bg min-h-screen flex items-center justify-center px-5">
        <div className="glass rounded-2xl p-8 text-center max-w-sm glow">
          <Logo size={30} />
          {loadError ? (
            <>
              <p className="mt-4 text-muted">Couldn&apos;t reach the server. Your session is fine — this is on our end.</p>
              <div className="mt-5 flex justify-center gap-2">
                <button
                  onClick={() => { setLoading(true); setLoadError(false); load(); }}
                  className="inline-block press rounded-lg brand-gradient px-5 py-2.5 font-medium text-white"
                >
                  Retry
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="mt-4 text-muted">Not logged in.</p>
              <div className="mt-5 flex justify-center gap-2">
                <Link href="/login" className="inline-block press rounded-lg brand-gradient px-5 py-2.5 font-medium text-white">Log in</Link>
              </div>
            </>
          )}
        </div>
      </main>
    );
  }

  const skills: string[] = me.profile ? parseJ<string[]>(me.profile.skills, []) : [];
  const resumeAts = me.profile?.resumeSuggestions
    ? parseJ<ResumeAnalysis>(me.profile.resumeSuggestions, {} as ResumeAnalysis).ats
    : undefined;
  // "Skipped" rows are internal bookkeeping — duplicates, below-threshold matches,
  // and firewall/scam blocks. None of it is actionable for the user, so it never
  // shows anywhere, "all" included. Everything else is real pipeline they can act on.
  const visibleApps = me.applications.filter((a) => a.status !== "skipped");
  const filteredApps = filter === "all"
    ? visibleApps
    : visibleApps.filter((a) => a.status === filter);
  const totalPages = Math.ceil(filteredApps.length / PAGE_SIZE);
  const apps = filteredApps.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const integrations = (me.integrations ?? []).filter((i) => VISIBLE_PLATFORMS.includes(i.platform));
  const connectedCount = integrations.filter((i) => i.status === "connected").length;
  // Human label for the delete-account modal's subscription line.
  const planLabel = normalizePlan(me.user.plan) === "pro" ? "Pro" : "Plus";
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
  // The old header-line "response rate" is gone: it was computed here over the
  // page of applications the client happens to hold, while the Outcomes panel
  // below shows the server's interview rate over ALL of them. Two different
  // numbers for the same idea, a few hundred pixels apart. The server's wins.
  //
  // Is the agent actually sending anything for THIS user? Drives whether the copy
  // says "you submit these" or "the agent sends what it can". Server-computed
  // from their real rows (/api/me), so it can't drift from what the agent does.
  const agentSendsSome = me.autoApply?.sendsAny ?? false;
  const agentSentCount = me.applications.filter(sentByAgent).length;

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
                <span><span className="font-medium">Run the agent.</span> It scores matches and <span className="font-medium">applies for you</span> wherever it can send on its own — a company&apos;s application form, an HR inbox, a careers portal, or Internshala. Anything it can&apos;t send itself lands here with an <span className="font-medium">Open &amp; submit</span> button for you. Then track the outcome here.</span>
              </li>
            </ol>
            <p className="mt-4 text-xs text-muted">Tip: <span className="text-foreground">Run now</span> searches every day for you — connecting a platform is optional (for auto-fill).</p>
            <button onClick={dismissOnboarding} className="mt-5 w-full press rounded-lg brand-gradient px-4 py-2.5 text-sm font-medium text-white hover:opacity-90 transition">
              Got it — let&apos;s go
            </button>
          </div>
        </div>
      )}

      {/* Account-deletion confirmation — the professional destructive-action
          pattern (GitHub/Stripe style): every consequence is spelled out and the
          user must TYPE "DELETE", so it can never be a stray tap. The API still
          independently enforces { confirm:true } as a second line of defence. */}
      {deleteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" onClick={() => !deleting && setDeleteOpen(false)}>
          <div className="glass rounded-2xl p-6 max-w-md w-full glow" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-display text-xl font-semibold text-danger">Delete your account?</h2>
            <p className="text-sm text-muted mt-2">This is permanent and takes effect immediately. Before you confirm:</p>
            <ul className="mt-3 space-y-2 text-sm">
              <li className="flex gap-2.5">
                <span className="shrink-0 font-bold text-danger">✕</span>
                <span>Your profile, resumes, match history, and every application record are erased — this <span className="font-medium text-foreground">cannot be undone</span>.</span>
              </li>
              <li className="flex gap-2.5">
                <span className="shrink-0 font-bold text-danger">✕</span>
                <span>
                  {me.user.paid ? (
                    <>Your <span className="font-medium text-foreground">{planLabel}</span> subscription is cancelled immediately. Billing stops, but the current period is <span className="font-medium text-foreground">not refunded</span>.</>
                  ) : (
                    <>You&apos;re on the <span className="font-medium text-foreground">free plan</span> — there&apos;s nothing to pay or cancel.</>
                  )}
                </span>
              </li>
              <li className="flex gap-2.5">
                <span className="shrink-0 font-bold text-danger">✕</span>
                <span>You&apos;re signed out everywhere and your connected platforms are unlinked.</span>
              </li>
            </ul>
            <div className="mt-4 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted">
              Just need a break? <span className="font-medium text-foreground">Pause the agent</span> from the account menu instead — it stops applying and keeps all your data.
            </div>
            <label htmlFor="delete-confirm" className="mt-4 block text-xs font-medium text-muted">
              Type <span className="font-mono font-semibold text-danger">DELETE</span> to confirm
            </label>
            <input
              id="delete-confirm"
              autoFocus
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder="DELETE"
              className="mt-1.5 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-danger"
            />
            <div className="mt-5 flex gap-2.5">
              <button
                type="button"
                onClick={() => setDeleteOpen(false)}
                disabled={deleting}
                className="press flex-1 rounded-lg border border-border px-4 py-2.5 text-sm font-medium hover:bg-surface transition disabled:opacity-50"
              >
                Keep my account
              </button>
              <button
                type="button"
                onClick={deleteAccount}
                disabled={deleting || deleteConfirmText.trim().toUpperCase() !== "DELETE"}
                className="press flex-1 rounded-lg bg-danger px-4 py-2.5 text-sm font-medium text-white hover:opacity-90 transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {deleting ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* In-app AI support chat — opened from the account menu */}
      {supportOpen && <SupportChat onClose={() => setSupportOpen(false)} />}

      {/* top bar */}
      <header className="sticky top-0 z-30 glass">
        <div className="mx-auto max-w-6xl px-5 h-16 flex items-center justify-between">
          <Link href="/"><Logo /></Link>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-sm">
              <span className={`size-2 rounded-full ${
                isRunning ? "bg-brand pulse-dot"
                : me.user.status === "paused" ? "bg-warn"
                : me.user.status === "active" ? "bg-accent pulse-dot"
                : "bg-muted"
              }`} />
              <span className="hidden sm:inline">
                {/* Connecting a platform is optional (discovery scrapes public
                    listings with no login), so an active user is "Agent active"
                    regardless — gating this on connectedCount told every default
                    beta user "Setup incomplete" when nothing was actually wrong. */}
                {isRunning ? "Agent working…"
                 : me.user.status === "paused" ? "Paused"
                 : me.user.status === "active" ? "Agent active"
                 : "Setup incomplete"}
              </span>
            </span>
            {/* Account menu — the avatar opens a popover holding identity, plan, and
                the account actions (profile, pause, admin, log out) that used to
                crowd the top bar. Same fixed-backdrop + absolute-panel pattern as the
                notifications bell, so click-outside closes it. */}
            <div className="relative">
              <button
                onClick={() => setUserMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={userMenuOpen}
                aria-label="Account menu"
                title="Your account"
                className="flex size-9 min-h-0 items-center justify-center rounded-full brand-gradient text-sm font-semibold text-white transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                {(me.user.name || me.user.email).trim().charAt(0).toUpperCase() || "?"}
              </button>
              {userMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setUserMenuOpen(false)} />
                  <div
                    role="menu"
                    className="absolute right-0 z-50 mt-2 w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface shadow-[0_10px_40px_rgba(23,20,15,0.18)]"
                  >
                    {/* identity + plan */}
                    <div className="border-b border-border px-4 py-3">
                      <div className="truncate text-sm font-semibold text-foreground">
                        {me.user.name || me.user.email.split("@")[0]}
                      </div>
                      <div className="truncate text-xs text-muted">{me.user.email}</div>
                      <div className="mt-1.5 text-xs text-muted">
                        <span className="capitalize font-medium text-foreground">{me.user.plan}</span> plan
                        {" · "}{me.quota.remaining}/{me.quota.cap} left today
                      </div>
                    </div>
                    {/* actions */}
                    <div className="py-1">
                      <button
                        role="menuitem"
                        onClick={() => { setTab("profile"); setUserMenuOpen(false); }}
                        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-foreground transition hover:bg-surface-2"
                      >
                        <span aria-hidden>👤</span> Your profile &amp; settings
                      </button>
                      {/* Integrations live here rather than as a tab: setup connects
                          Internshala and nothing else, so this is where a user goes
                          to add or change one afterwards. */}
                      <Link
                        role="menuitem"
                        href="/integrations"
                        onClick={() => setUserMenuOpen(false)}
                        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-foreground transition hover:bg-surface-2"
                      >
                        <span aria-hidden>🔌</span> Integrations
                        {connectedCount > 0 && (
                          <span className="ml-auto text-xs text-accent">{connectedCount} connected</span>
                        )}
                      </Link>
                      <button
                        role="menuitem"
                        onClick={() => { void togglePause(); setUserMenuOpen(false); }}
                        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-foreground transition hover:bg-surface-2"
                      >
                        <span aria-hidden>{me.user.status === "paused" ? "▶️" : "⏸️"}</span>
                        {me.user.status === "paused" ? "Resume agent" : "Pause agent"}
                      </button>
                      {me.user.role === "admin" && (
                        <Link
                          role="menuitem"
                          href="/admin"
                          onClick={() => setUserMenuOpen(false)}
                          className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-foreground transition hover:bg-surface-2"
                        >
                          <span aria-hidden>🛡️</span> Admin console
                        </Link>
                      )}
                      <button
                        role="menuitem"
                        onClick={() => { setSupportOpen(true); setUserMenuOpen(false); }}
                        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-foreground transition hover:bg-surface-2"
                      >
                        <span aria-hidden>💬</span> Contact support
                      </button>
                    </div>
                    <div className="border-t border-border py-1">
                      <button
                        role="menuitem"
                        onClick={() => { void logout(); }}
                        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-danger transition hover:bg-danger/10"
                      >
                        <span aria-hidden>↩️</span> Log out
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-5 py-8">
        {/* Profile & settings is a dedicated full-screen view: a back bar on top, and
            the dashboard "home" (greeting, stats, funnel, run controls) hidden below
            so it reads as its own page instead of a scroll target. */}
        {tab === "profile" && (
          <div className="mb-6 flex items-center justify-between gap-3 border-b border-border pb-4">
            <h1 className="font-display text-2xl font-semibold tracking-tight">Profile &amp; settings</h1>
            <button
              onClick={() => setTab("applications")}
              className="shrink-0 rounded-lg border border-border px-3.5 py-2 text-sm text-muted transition hover:border-brand/40 hover:text-foreground"
            >
              ← Back to dashboard
            </button>
          </div>
        )}

        {tab !== "profile" && (
        <>
        {/* header row */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-3xl font-semibold tracking-tight">
              Hi {me.user.name || me.user.email.split("@")[0]}
            </h1>
            {/* Two facts, not five. "min match ≥55" is a scoring threshold the
                agent uses internally and nobody outside this codebase can act
                on; "N platforms connected" duplicates the Integrations page; the
                response rate has its own Outcomes panel below with the sample
                size next to it. A header line is for orienting, not reporting. */}
            <p className="text-muted text-sm mt-1">
              <span className="capitalize text-foreground font-medium">{me.user.plan}</span> plan
              {" "}· {me.quota.remaining} of {me.quota.cap} applications left today
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
              title="Optional — your agent already runs automatically every day. This starts one extra search right now."
              className="press rounded-lg brand-gradient px-4 py-2.5 text-sm font-medium text-white hover:opacity-90 transition disabled:opacity-50"
            >
              Run now
            </button>
            )}
          </div>
        </div>

        {/* Always-on reassurance: the agent runs on its own daily (see agent/sweep.py),
            so a finished manual run must not read as "the agent stopped." Shown for any
            active, not-running user — platform connect is optional (discovery needs no
            login), so a no-platform user is on duty too. */}
        {me.user.status === "active" && !isRunning && (
          <p className="mt-3 flex items-start gap-2 text-xs text-muted">
            <span className="mt-1 size-1.5 shrink-0 rounded-full bg-accent pulse-dot" />
            {/* Precise about WHICH part is automatic. "You never have to press
                anything" read as a promise that every application sends itself,
                which is only true where the agent can deliver on its own — an
                employer's own form, or a board with the browser extension on.
                Board applications without it still wait for a tap, and a claim
                the product does not keep is worse than one it never made. */}
            <span>Your agent is on duty — it searches, scores and prepares matches every day on its own, and sends the ones it can deliver by itself. Applications on sites that hold your account wait for your tap unless you turn on the browser extension. <span className="text-foreground">Run now</span> just starts one extra search this minute.</span>
          </p>
        )}

        {/* ── Autopilot ─────────────────────────────────────────────────────
            What the agent actually did, from the same ledger that enforces the
            daily cap — so the number here can never disagree with the number of
            applications the employer received. "Submitted" is kept strictly
            separate from queued/prepared: folding them together would inflate a
            user's sense of their own job search. */}
        {autopilot && me.user.status === "active" && (
          <section className="mt-6 rounded-2xl border border-border bg-surface p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="font-display text-lg font-semibold">Autopilot</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    autopilot.state === "active"
                      ? "bg-accent/15 text-accent"
                      : autopilot.state === "paused"
                        ? "bg-surface-2 text-muted"
                        : "bg-amber-500/15 text-amber-600"
                  }`}
                >
                  {autopilot.state === "active"
                    ? "On duty"
                    : autopilot.state === "paused"
                      ? "Paused"
                      : "Setup incomplete"}
                </span>
              </div>
              <span className="text-xs text-muted">
                Today is counted in {autopilot.today.timezone}
              </span>
            </div>

            {/* Not-ready is never silent: name what is missing and link to it. */}
            {!autopilot.readiness.ready && autopilot.readiness.missing.length > 0 && (
              <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                <p className="text-sm text-foreground">
                  The agent is finding and preparing matches, but it will not send
                  anything until this is done:
                </p>
                <ul className="mt-2 space-y-1 text-sm text-muted">
                  {autopilot.readiness.missing.map((m) => (
                    <li key={m} className="flex gap-2">
                      <span aria-hidden className="text-amber-600">•</span>
                      <span>{m}</span>
                    </li>
                  ))}
                </ul>
                <Link href="/onboarding" className="mt-2 inline-block text-sm text-brand-2 underline">
                  Finish setup →
                </Link>
              </div>
            )}

            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: "Sent today", value: `${autopilot.today.submitted}/${autopilot.today.limit}`,
                  hint: "confirmed submissions only — an attempt the site never confirmed is not counted here" },
                { label: "Left today", value: autopilot.today.remaining,
                  hint: "allowance still free — an unconfirmed attempt keeps its slot, because it may have gone through" },
                { label: "In queue", value: autopilot.queued,
                  hint: "matched and waiting their turn" },
                { label: "Sent all-time", value: autopilot.lifetimeSubmitted,
                  hint: "confirmed submissions" },
              ].map((s) => (
                <div key={s.label} className="rounded-xl border border-border bg-surface-2 p-3" title={s.hint}>
                  <div className="text-xs text-muted">{s.label}</div>
                  <div className="mt-1 text-2xl font-semibold text-foreground">{s.value}</div>
                </div>
              ))}
            </div>

            {/* "Sent 0 of 5" next to "0 left" reads as a contradiction unless
                the gap is named. It is not a rounding artefact: those slots are
                held by attempts nobody could confirm, and they are held on
                purpose, because an application that may have reached an
                employer must not be sent twice. */}
            {(autopilot.today.reserved ?? 0) > autopilot.today.submitted && (
              <p className="mt-3 text-xs text-muted">
                {(autopilot.today.reserved ?? 0) - autopilot.today.submitted} of today&apos;s
                slots are held by attempts the site never confirmed. They stay held
                until you check them — sending one twice is worse than sending none.
              </p>
            )}

            {/* Action needed — the only part of this panel that asks the user
                for something, so it sits above the history and says plainly
                what happened. The agent stopped here on purpose: a CAPTCHA, a
                login or a question it could not answer honestly. */}
            {autopilot.actionNeeded?.length > 0 && (
              <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
                <div className="text-sm font-semibold text-foreground">
                  Needs you ({autopilot.actionNeeded.length})
                </div>
                <p className="mt-0.5 text-xs text-muted">
                  Grindly stopped rather than guess. Open each one, do the bit only
                  you can, and it carries on from there.
                </p>
                <ul className="mt-3 space-y-2">
                  {autopilot.actionNeeded.map((t) => (
                    <li key={t.id} className="flex items-start justify-between gap-3 text-sm">
                      <span className="min-w-0 text-muted">
                        <span className="text-foreground">{t.host}</span> — {t.says}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {/* Nothing requeues a stopped task on its own — a task
                            that might have submitted must never re-run by
                            itself. So once the person has done their part, they
                            need a way to say so, or the queue is simply dead. */}
                        <button
                          onClick={() => retryTask(t.id)}
                          disabled={retryingTaskId === t.id}
                          className="rounded-md border border-amber-500/40 px-2.5 py-1 text-xs text-amber-700 hover:bg-amber-500/10 transition disabled:opacity-50"
                        >
                          {retryingTaskId === t.id ? "Queuing…" : "Try again"}
                        </button>
                        <a
                          href={t.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded-md border border-amber-500/40 px-2.5 py-1 text-xs text-amber-700 hover:bg-amber-500/10 transition"
                        >
                          Open →
                        </a>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Browser health. An action-needed list with no paired browser is a
                dead end, so say so instead of leaving the user to wonder. */}
            {autopilot.browser && (
              <p className="mt-3 flex items-center gap-2 text-xs text-muted">
                <span
                  className={`size-1.5 rounded-full ${
                    autopilot.browser.connected ? "bg-accent" : "bg-border"
                  }`}
                  aria-hidden
                />
                {autopilot.browser.connected
                  ? `Browser connected${autopilot.browser.lastSeen ? ` · last seen ${new Date(autopilot.browser.lastSeen).toLocaleString()}` : ""}`
                  : "No browser connected — board applications wait for you until one is."}
              </p>
            )}

            {autopilot.timeline.length > 0 && (
              <div className="mt-5">
                <div className="text-xs uppercase tracking-wide text-muted mb-2">
                  Recent activity
                </div>
                <ul className="space-y-2">
                  {autopilot.timeline.slice(0, 8).map((t) => (
                    <li key={t.id} className="flex items-start justify-between gap-3 text-sm">
                      <div className="min-w-0">
                        <span className="font-medium text-foreground">{t.jobTitle}</span>
                        <span className="text-muted"> · {t.company}</span>
                        {/* Who acted is the point of this list — "the agent sent
                            it" and "you sent it" must never look identical. */}
                        {t.applyTier === "A" && (
                          <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-xs text-accent">
                            agent sent
                          </span>
                        )}
                      </div>
                      <span className="shrink-0 text-xs text-muted">
                        {t.status === "needs_review" ? "check it" : t.status}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        {/* run / connect result notice — a floating corner toast, not an inline
            banner. "Connected" confirmations auto-dismiss (see effect above); run
            outcomes/errors stay until the × is clicked. */}
        {notice && (
          <div
            role="status"
            aria-live="polite"
            className={`animate-in fixed bottom-4 right-4 left-4 z-[70] flex items-start justify-between gap-3 rounded-xl border bg-surface px-4 py-3 text-sm shadow-lg sm:left-auto sm:max-w-sm ${
              notice.kind === "ok" ? "border-accent/50"
              : notice.kind === "err" ? "border-danger/50"
              : "border-brand/50"
            }`}
          >
            <div className="flex items-start gap-2.5">
              <span className={`mt-1.5 size-2 shrink-0 rounded-full ${
                notice.kind === "ok" ? "bg-accent" : notice.kind === "err" ? "bg-danger" : "bg-brand"
              }`} />
              <span className="text-foreground">{notice.text}</span>
            </div>
            <button onClick={() => setNotice(null)} aria-label="Dismiss" className="shrink-0 text-muted hover:text-foreground transition">×</button>
          </div>
        )}

        {/* Readiness nudge — a platform is connected, but the profile is still thin.
            Non-blocking (Run agent still works): the agent auto-fills phone/GPA from
            the resume, so the main gaps left are "no resume yet" or "no phone found".
            Points to the profile page to finish. */}
        {connectedCount > 0 && !isRunning && me.profile && (!me.profile.resumeName || !me.profile.phone) && (
          <div className="mt-5 rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">
            <span className="font-medium">Finish setup for better matches:</span>{" "}
            {[
              !me.profile.resumeName ? "upload your resume (the agent matches on it and pulls your phone & GPA from it)" : null,
              !me.profile.phone ? "add your phone number so application forms submit" : null,
            ].filter(Boolean).join(" · ")}.{" "}
            <button onClick={() => setTab("profile")} className="underline font-medium">Open profile →</button>
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

        {/* ONE next-action banner.

            This used to be a stack: a no-platform banner, a ready-count banner and
            a caught-up banner, each with its own independent condition, sitting on
            top of the on-duty line, the readiness nudge, the quota notice and the
            reconnect warnings. A user could face six boxes at once and none of
            them said which to do first — and two of them contradicted each other
            ("you're all caught up" printed while approved applications sat unsent).

            So: decide the single most important thing, and say only that. The
            order below IS the priority order. */}
        {(() => {
          const toSubmit = apps.filter((a) => a.status === "approved").length;
          const needsCheck = apps.filter((a) => a.status === "needs_review").length;

          // 1. Something is waiting on the user, in the order it blocks them.
          if (toSubmit > 0) {
            return (
              <Banner tone="brand"
                title={`${toSubmit} application${toSubmit !== 1 ? "s" : ""} ready to send`}
                body="You opened these. Send each one, then tick it off so your count stays right."
                action={{ label: "Open the list →", onClick: () => { setTab("applications"); setFilter("approved"); } }}
              />
            );
          }
          if (readyCount > 0) {
            return (
              <Banner tone="brand"
                title={`${readyCount} match${readyCount !== 1 ? "es" : ""} found for you`}
                body={agentSendsSome
                  ? "The agent sends the ones it can on its own. The rest are on sites that hold your account, so those need one tap from you."
                  : "Open each one to send it. The agent has already written the resume and cover letter for it."}
                action={{ label: "See matches →", onClick: () => { setTab("applications"); setFilter("matched"); } }}
                secondary={{
                  label: approvingAll ? "Lining up…" : `Line up all ${readyCount}`,
                  onClick: approveAllApplications,
                  disabled: approvingAll,
                }}
              />
            );
          }
          if (needsCheck > 0) {
            return (
              <Banner tone="warn"
                title={`${needsCheck} application${needsCheck !== 1 ? "s" : ""} to double-check`}
                body="The agent submitted these but the site didn't confirm it. Open each one and check before sending again."
                action={{ label: "Check them →", onClick: () => { setTab("applications"); setFilter("all"); } }}
              />
            );
          }

          // 2. Nothing waiting. Say what the agent is doing, not "you're done".
          if (me.quota.remaining === 0) {
            return (
              <Banner tone="muted"
                title={`That's today's ${me.quota.cap} applications.`}
                body="The agent picks up again tomorrow. Spacing them out is what keeps your accounts safe."
              />
            );
          }
          if (me.stats.queued > 0) {
            return (
              <Banner tone="muted"
                title="You're all caught up for today."
                body={`The agent has already found ${me.stats.queued} more ${me.stats.queued === 1 ? "role" : "roles"} for you and releases a fresh batch each day. Check back tomorrow.`}
              />
            );
          }
          if (apps.length === 0) {
            return (
              <Banner tone="brand"
                title="Your agent is searching."
                body="It runs on its own every day. Hit Run now if you want a search this minute."
              />
            );
          }
          return null;
        })()}

        {/* reconnect warnings */}
        {integrations.filter((i) => i.status === "needs_login").map((i) => (
          <div key={i.platform} className="mt-3 flex items-center justify-between rounded-xl border border-warn/40 bg-warn/10 px-4 py-2.5 text-sm text-warn">
            <span>{PLATFORM_META[i.platform]?.label ?? i.platform} login expired — reconnect to resume live applications.</span>
            <Link href="/integrations" className="ml-4 shrink-0 rounded-lg border border-warn/60 px-3 py-1 text-xs hover:bg-warn/20 transition">Reconnect</Link>
          </div>
        ))}

        {/* stats — plain words only. "Matched" is today's batch, due now, waiting on
            one tap. "Lined up" is the rest of the month, which the agent releases a
            day at a time; the user is told the work exists but is never handed the
            list (src/lib/pipeline.ts). We deliberately dropped the old "Avg match"
            tile: it averaged over skipped low-score rows too, so it could read "10"
            under a "min match ≥65" header — a contradiction that just confused. */}
        {/* Tiles are labelled by WHO ACTS NEXT, because that is the only thing a
            user needs from a number. "Applied" hid the distinction that now
            matters most — whether the agent sent it or the user did — so it
            splits once the agent has actually sent something. */}
        <div className={`mt-6 grid grid-cols-2 gap-3 ${me.stats.failed > 0 || agentSentCount > 0 ? "sm:grid-cols-4" : "sm:grid-cols-3"}`}>
          {([
            ["Needs you", me.stats.ready, "text-foreground", "Ready now — open each one and send it"],
            ["Lined up", me.stats.queued, "text-muted", "Found for you and waiting — the agent releases a fresh batch each day so your applications stay paced"],
            ...(agentSentCount > 0
              ? [
                  ["Agent sent", agentSentCount, "text-accent", "The agent submitted these to the company itself — nothing was needed from you"] as const,
                  ["You sent", Math.max(0, me.stats.applied - agentSentCount), "text-accent", "Applications you submitted and confirmed"] as const,
                ]
              : [["Applied", me.stats.applied, "text-accent", "Submitted and confirmed"] as const]),
            // "Failed" only surfaces when there's actually a failure to act on — a
            // resting "Failed: 0" tile just added noise and worried testers.
            // It no longer claims a retry: nothing in the codebase re-attempts a
            // failed row, and telling a user to wait for a retry that never comes
            // is how a real application quietly dies.
            ...(me.stats.failed > 0
              ? [["Failed", me.stats.failed, "text-danger", "These didn't go through. Open them and send them yourself — the agent won't retry them on its own"] as const]
              : []),
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
            {/* How outcomes actually reach here. Honest: a company contacts the
                student directly — Grindly tracks it, either automatically from Gmail
                (once that's connected and the scope is live) or by the student
                marking it. Answers the very common "how will I know I got an
                interview?" question right where the funnel lives. */}
            <div className="mt-3 space-y-1.5 border-t border-border/60 pt-2.5">
              {me.user.gmailScanBeta && me.user.gmailConnected ? (
                <p className="text-xs text-accent">
                  ✓ Grindly reads interview, offer, and rejection emails from your inbox and updates these automatically.
                </p>
              ) : me.user.gmailScanBeta ? (
                <p className="text-xs text-muted">
                  Companies email or call you directly.{" "}
                  <Link href="/integrations" className="underline text-brand-2">Connect Gmail</Link>{" "}
                  and Grindly auto-detects interview emails for you — otherwise mark each outcome yourself.
                </p>
              ) : (
                <p className="text-xs text-muted">
                  Companies reach out to you directly — by email or phone — so watch your inbox after applying.
                  Grindly can&apos;t see that, so when you hear back, mark it on the application to keep your interview rate accurate.
                </p>
              )}
              {me.stats.outcomeReported < me.stats.applied && (
                <p className="text-xs text-muted">
                  <button onClick={() => { setTab("applications"); setFilter("applied"); }} className="underline text-brand-2">Set outcomes →</button>
                  {" "}{me.stats.applied - me.stats.outcomeReported} application{me.stats.applied - me.stats.outcomeReported !== 1 ? "s" : ""} still need one.
                </p>
              )}
            </div>
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
        </>
        )}

        {/* Resume intelligence.
            Collapsed by default. This panel is genuinely useful — and it is a
            screenful of scores, issues, suggestions, skill chips and generated
            resume variants that sat ABOVE the tab strip permanently, so a user
            who clicked "Applications" to look at their matches had to scroll
            past all of it every single time. It is reference material, not the
            daily job, so it opens on request and shows a one-line summary
            otherwise. */}
        {me.profile && !resumePanelOpen && (
          <button
            onClick={() => setResumePanelOpen(true)}
            className="mt-6 flex w-full items-center justify-between rounded-xl border border-border bg-surface px-4 py-3 text-left text-sm hover:border-brand/40 transition"
          >
            <span className="flex items-center gap-3">
              <span className="text-xs uppercase tracking-wide text-muted">Resume</span>
              {me.profile.resumeScore != null ? (
                <span className={resumeScoreColor(me.profile.resumeScore)}>
                  {me.profile.resumeScore}/100
                </span>
              ) : (
                <span className="text-muted">
                  {me.profile.resumeName ? "Not analysed yet" : "No resume uploaded"}
                </span>
              )}
              {skills.length > 0 && (
                <span className="text-muted">· {skills.length} skills the agent matches on</span>
              )}
            </span>
            <span className="text-xs text-brand-2">Open →</span>
          </button>
        )}
        {me.profile && resumePanelOpen && (
          <div className="mt-6 rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center justify-between mb-3">
              <button
                onClick={() => setResumePanelOpen(false)}
                className="text-xs uppercase tracking-wide text-muted hover:text-foreground transition"
              >
                Resume Intelligence ▾
              </button>
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
                <div className="text-xs text-muted mb-2">
                  These are what the agent scores every job against. Add any skill your resume
                  missed so it finds those roles; remove anything that isn&apos;t really you —
                  a wrong skill pulls in mismatched jobs. Type and press Enter.
                </div>
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
                  {/* Score + grade row. The big number is the ATS score — labelled
                      explicitly so students know it's the recruiter-software screen,
                      not a vague "quality" number. */}
                  <div className="flex items-center gap-4">
                    <div className="flex flex-col">
                      <span
                        className="text-[10px] font-semibold uppercase tracking-wide text-muted cursor-help"
                        title="ATS = Applicant Tracking System — the software recruiters use to auto-screen resumes before a human ever reads them. A higher score means yours parses cleanly and matches the role."
                      >
                        ATS Score
                      </span>
                      <div className="flex items-baseline gap-1">
                        <span className={`text-4xl font-bold ${resumeScoreColor(analysis.score)}`}>
                          {analysis.score}
                        </span>
                        <span className="text-muted text-sm">/100</span>
                      </div>
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

                  {/* Skills strip — this list IS the agent's matching fuel, so we say
                      so plainly and put the edit affordance right here where the skills
                      are, not only in the far-away panel header. */}
                  {skills.length > 0 && (
                    <div>
                      <div className="text-xs text-muted mb-1.5">Skills the agent matches you on</div>
                      <div className="flex flex-wrap gap-1.5">
                        {skills.map((s) => (
                          <span key={s} className="rounded-md bg-brand/15 px-2 py-0.5 text-xs text-brand-2">{s}</span>
                        ))}
                      </div>
                      <p className="mt-2 text-[11px] text-muted">
                        The agent scores every job against these. Missing one you actually have?{" "}
                        <button
                          onClick={() => { setSkillsDraft(skills); setEditingSkills(true); }}
                          className="underline hover:text-foreground transition"
                        >
                          Add it
                        </button>{" "}
                        so those roles show up in your matches.
                      </p>
                    </div>
                  )}
                </div>
              );
            })() : (
              <div className="text-sm text-muted">
                {me.profile.resumeName
                  ? "Analysis in progress — check back in a moment."
                  : "Upload your resume below to get your ATS score and improvement suggestions."}
                {skills.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {skills.map((s) => (
                      <span key={s} className="rounded-md bg-brand/15 px-2 py-0.5 text-xs text-brand-2">{s}</span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ATS-optimized versions. Opt-in ("show me 3 better resumes"): the AI
                rebuilds the resume on a clean, parser-friendly template and rewrites
                the wording three ways — never inventing skills/projects — then each
                is compiled and RE-SCORED, so only versions that measurably beat the
                master are shown. Picking one makes it the master. */}
            {me.profile.resumeScore != null && (() => {
              const status = me.profile!.resumeVariantStatus;
              const variants = me.resumeVariants ?? [];
              const busy = optimizing || status === "generating";
              return (
                <div className="mt-6 border-t border-border pt-5">
                  <div className="text-xs uppercase tracking-wide text-muted mb-2">ATS-optimized versions</div>

                  {/* Primary CTA — this is the flagship feature (the AI rebuilds your
                      resume into higher-scoring versions, same facts), so it gets a
                      full-width branded card, not a tiny link. Hidden while building,
                      once versions exist, or when nothing could beat the current score;
                      those states have their own UI below. */}
                  {!busy && variants.length === 0 && status !== "no_gain" && status !== "failed" && status !== "error" && (
                    <button
                      onClick={optimizeResume}
                      className="group mb-3 block w-full rounded-xl border border-brand/40 bg-gradient-to-br from-brand/10 to-accent/10 p-4 text-left transition hover:border-brand/70"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                            <span className="text-lg" aria-hidden>✨</span>
                            Get 3 AI-optimized versions of your resume
                          </div>
                          <p className="mt-1 text-xs text-muted">
                            Higher ATS score, <span className="text-foreground">same facts</span> — rebuilt on a
                            recruiter-friendly template, rewritten three ways, then re-scored. Pick the best and it
                            becomes your resume. Nothing is invented.
                          </p>
                        </div>
                        <span className="shrink-0 rounded-lg brand-gradient px-4 py-2.5 text-sm font-medium text-white transition group-hover:opacity-90">
                          Generate →
                        </span>
                      </div>
                    </button>
                  )}

                  {/* Compact controls once versions exist (the cards below carry the value). */}
                  {!busy && variants.length > 0 && (
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <p className="text-xs text-muted">
                        Rewrites of your <em>real</em> resume, scored after compiling — measured, not guessed.
                      </p>
                      <button
                        onClick={optimizeResume}
                        className="shrink-0 text-xs text-brand-2 hover:text-brand transition"
                        title="Generate a fresh set — no invented skills, same facts"
                      >
                        ↻ Regenerate
                      </button>
                    </div>
                  )}

                  {busy && (
                    <div className="rounded-lg border border-brand/30 bg-brand/5 px-3 py-3 text-xs text-muted flex items-center gap-2">
                      <span className="inline-block size-3 rounded-full border-2 border-brand/40 border-t-brand animate-spin" />
                      Building and scoring optimized versions — this takes up to a minute.
                    </div>
                  )}

                  {!busy && status === "no_gain" && (
                    <div className="rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-xs text-muted">
                      {me.profile!.resumeVariantDetail ||
                        "None of the rewrites beat your current resume without changing the facts."}{" "}
                      <button onClick={optimizeResume} className="underline font-medium text-brand-2">Try again →</button>
                    </div>
                  )}

                  {/* "error" is OUR failure (generator crashed, nothing compiled,
                      unreadable output) — kept visibly distinct from "no_gain" so
                      a user is never told their resume was too good to improve
                      when the truth is that our pipeline broke. */}
                  {!busy && status === "error" && (
                    <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2.5 text-xs text-warn">
                      {me.profile!.resumeVariantDetail ||
                        "Something broke on our side while building your versions — this isn't your resume."}{" "}
                      <button onClick={optimizeResume} className="underline font-medium">Try again →</button>
                      {" · "}
                      <button onClick={() => setSupportOpen(true)} className="underline font-medium">Tell support</button>
                    </div>
                  )}

                  {!busy && status === "failed" && (
                    <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2.5 text-xs text-warn">
                      {me.profile!.resumeVariantDetail || "Couldn't build optimized versions this time."}{" "}
                      <button onClick={optimizeResume} className="underline font-medium">Try again →</button>
                    </div>
                  )}

                  {!busy && variants.length > 0 && (
                    <div className="grid gap-3 sm:grid-cols-3">
                      {variants.map((v) => {
                        const delta = v.score - v.baselineScore;
                        return (
                          <div key={v.id} className="flex flex-col rounded-lg border border-border bg-surface p-3">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-semibold text-foreground">{v.label}</span>
                              <span className={`rounded-md border px-1.5 py-0.5 text-[0.65rem] font-bold ${resumeGradeBg(v.grade)}`}>
                                {v.grade}
                              </span>
                            </div>
                            <div className="mt-1 flex items-baseline gap-1.5">
                              <span className={`text-2xl font-bold ${resumeScoreColor(v.score)}`}>{v.score}</span>
                              <span className="text-[0.7rem] text-muted">/100</span>
                              {delta > 0 && (
                                <span className="text-[0.7rem] font-semibold text-accent">+{delta}</span>
                              )}
                            </div>
                            {/* A version that scores BELOW the master never reaches
                                this list — the generator discards it. So delta<=0
                                here means a tie: same score, cleaner template. Say
                                that, rather than the old "preview only", which was
                                written when losers were displayed too. */}
                            {delta <= 0 && (
                              <div className="mt-1 text-[0.65rem] text-muted">
                                {delta === 0
                                  ? `Same score as your current ${v.baselineScore}`
                                  : `Level with your current ${v.baselineScore}, within our scorer's margin`}
                                {" — cleaner, parser-friendly layout"}
                              </div>
                            )}
                            {v.changes.length > 0 && (
                              <ul className="mt-2 space-y-1">
                                {v.changes.map((c, i) => (
                                  <li key={i} className="text-[0.7rem] text-muted flex gap-1">
                                    <span className="text-accent shrink-0">→</span>{c}
                                  </li>
                                ))}
                              </ul>
                            )}
                            <div className="mt-3 flex items-center gap-2 pt-1">
                              <a
                                href={`/api/resume/variants/${v.id}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="rounded-md border border-border px-2 py-1 text-[0.7rem] text-muted hover:text-foreground transition"
                              >
                                Preview
                              </a>
                              <button
                                onClick={() => selectResumeVariant(v)}
                                disabled={usingVariant === v.id}
                                title={delta > 0
                                  ? "Make this your master resume"
                                  : `Same ${v.score} as your current resume, on a template parsers read more reliably`}
                                className={`press rounded-md px-2.5 py-1 text-[0.7rem] font-medium transition disabled:opacity-50 ${
                                  delta > 0
                                    ? "brand-gradient text-white hover:opacity-90"
                                    : "border border-border text-muted hover:text-foreground"
                                }`}
                              >
                                {usingVariant === v.id ? "Switching…" : "Use as my resume"}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Resume file. One slot up front — the file recruiters actually receive.
                The .tex source is a power-user extra, so it's tucked into an Advanced
                disclosure: it was the single most confusing thing on this screen, and
                almost no student has a .tex to give. With no .tex the agent sends the
                resume untouched rather than rebuilding a lookalike and wrecking the
                template the college mandated. */}
            <div className="mt-6 border-t border-border pt-5">
              <div className="text-xs uppercase tracking-wide text-muted mb-3">Resume file</div>
              <ResumeSlot
                label="Your resume"
                hint="PDF, DOCX or TXT · this is the exact file recruiters receive"
                current={me.profile.resumeName}
                accept={RESUME_ACCEPT_ATTR}
                busy={uploading === "master"}
                onPick={(f) => uploadResume(f, "master")}
              />
              <p className="mt-3 text-xs text-muted">
                Replacing it re-extracts your skills and re-scores your resume — the
                agent uses the new one from its next run.
              </p>

              {/* Advanced: LaTeX source — hidden by default so it stops confusing the
                  90% of students who don't have a .tex. */}
              <details className="mt-4">
                <summary className="cursor-pointer select-none text-xs font-medium text-brand-2 hover:text-brand transition">
                  Advanced: upload LaTeX source (optional)
                </summary>
                <div className="mt-3">
                  <ResumeSlot
                    label="LaTeX source (.tex)"
                    hint="Lets the agent tailor per job without breaking your template"
                    current={me.profile.resumeTexName}
                    accept=".tex"
                    busy={uploading === "tex"}
                    onPick={(f) => uploadResume(f, "tex")}
                    status={me.profile.resumeTexStatus}
                    detail={me.profile.resumeTexDetail}
                  />
                  <p className="mt-3 text-xs text-muted">
                    Have your resume&apos;s <span className="text-foreground">.tex</span>{" "}
                    source? Upload it and the agent tailors a version per job without
                    touching your layout — it only ever edits the{" "}
                    <span className="text-foreground">Skills</span> and{" "}
                    <span className="text-foreground">Hobbies</span> sections, and throws
                    the edit away if it changes your page count. Most people can skip this.
                  </p>
                </div>
              </details>
            </div>
          </div>
        )}

        {/* Tab strip — only in dashboard mode. In the profile view the strip would
            show with nothing active (a phantom tab); that view has its own top
            back-bar instead, and the home content above is hidden. */}
        {tab !== "profile" && (
          <div className="mt-8 flex items-center gap-2 border-b border-border overflow-x-auto scrollbar-none">
            {(["applications", "reports"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`shrink-0 px-4 py-2.5 text-sm capitalize border-b-2 -mb-px transition ${
                  tab === t ? "border-brand text-foreground" : "border-transparent text-muted hover:text-foreground"
                }`}
              >
                {t}
                {t === "applications" && readyCount > 0 && (
                  <span className="ml-1.5 rounded-full bg-warn/20 px-1.5 py-0.5 text-[10px] text-warn">{readyCount}</span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* ── PROFILE ── */}
        {tab === "profile" && profileForm && (
          <div className="mt-6 max-w-xl space-y-6">
            {/* Your details first — phone + GPA are what users open this page looking
                for ("where's my CGPA?"), so they lead rather than sit at the bottom.
                The agent prefills these from your resume; you confirm them here. */}
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted mb-4">Your details</h2>
              <p className="text-xs text-muted mb-4">
                Phone and GPA — filled into platform application forms automatically. The agent
                grabs these from your resume when it can; check they&apos;re right.
              </p>
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

            {/* The facts screening forms ask for. These were collectable only
                during setup, so a user whose application stalled on "current
                salary" had nowhere to go and fix it — the agent refuses to
                invent one, so that application waits forever. Same fields, same
                renderer as setup; blanks are named rather than left to be
                discovered one stalled application at a time. */}
            {(["About you", "Education"] as const).map((group) => (
              <div key={group}>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted mb-4">
                  {group}
                </h2>
                {group === "About you" && (
                  <p className="text-xs text-muted mb-4">
                    Typed into application forms exactly as written here. Anything left
                    blank is a question the agent will not answer for you — those
                    applications wait instead of being sent with a guess.
                  </p>
                )}
                <div className="space-y-4">
                  {PROFF_FIELDS.filter((f) => f.group === group).map((f) => (
                    <div key={f.key}>
                      <label htmlFor={`field-${f.key}`} className="block text-sm font-medium mb-1">
                        {f.label}
                        {f.required && <span className="ml-1 text-danger">*</span>}
                      </label>
                      <p className="text-xs text-muted mb-1.5">{f.help}</p>
                      {f.type === "choice" && (
                        <ChoiceField
                          field={f}
                          value={blankIfUnset(profileForm[f.key as keyof ProfileForm])}
                          onChange={(v) =>
                            patchForm(f.key as keyof ProfileForm, v as ProfileForm[keyof ProfileForm])
                          }
                        />
                      )}
                      {f.type === "select" && (
                        <select
                          id={`field-${f.key}`}
                          value={blankIfUnset(profileForm[f.key as keyof ProfileForm])}
                          onChange={(e) =>
                            patchForm(
                              f.key as keyof ProfileForm,
                              (f.numeric
                                ? Number(e.target.value)
                                : e.target.value) as ProfileForm[keyof ProfileForm],
                            )
                          }
                          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none"
                        >
                          <option value="">Select…</option>
                          {f.options?.map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      )}
                      {(f.type === "text" || f.type === "number") && (
                        <div className="flex items-center gap-2">
                          <input
                            id={`field-${f.key}`}
                            type={f.type}
                            value={blankIfUnset(profileForm[f.key as keyof ProfileForm])}
                            placeholder={f.placeholder}
                            onChange={(e) =>
                              patchForm(
                                f.key as keyof ProfileForm,
                                (f.type === "number"
                                  ? Number(e.target.value)
                                  : e.target.value) as ProfileForm[keyof ProfileForm],
                              )
                            }
                            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none"
                          />
                          {f.suffix && <span className="text-sm text-muted">{f.suffix}</span>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}

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
                    {f.type === "select" && (
                      <div className="flex items-center gap-2">
                        <select
                          id={`field-${f.key}`}
                          value={blankIfUnset(profileForm[f.key as keyof ProfileForm])}
                          onChange={(e) =>
                            patchForm(
                              f.key as keyof ProfileForm,
                              (f.numeric
                                ? Number(e.target.value || 0)
                                : e.target.value) as ProfileForm[keyof ProfileForm],
                            )
                          }
                          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none"
                        >
                          {/* Empty = "whatever my plan allows", the same reading
                              worker._cap_for gives a stored 0. Offering it keeps
                              the setting reversible without a magic number. */}
                          <option value="">My plan&apos;s maximum</option>
                          {f.options?.map((o) => (
                            <option key={o} value={o}>{o}</option>
                          ))}
                        </select>
                        {f.suffix && <span className="text-sm text-muted">{f.suffix}</span>}
                      </div>
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
                        <span className="text-sm">{profileForm.autoApply ? "On — agent sends what it can on its own, the rest wait for your tap" : "Off — agent only shortlists, nothing gets prepped until you turn this on"}</span>
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

            <button
              onClick={saveProfile}
              disabled={profileSaving}
              className="press rounded-lg brand-gradient px-5 py-2.5 text-sm font-medium text-white hover:opacity-90 transition disabled:opacity-50"
            >
              {profileSaving ? "Saving…" : profileSaved ? "Saved ✓" : "Save profile"}
            </button>

            {/* ── Account · Danger zone ── relocated here from Integrations so
                account deletion lives with the other account settings. The loud
                one-tap box is gone; deletion now runs through a typed-confirmation
                modal that spells out permanence + subscription consequences. */}
            <div className="mt-10 border-t border-border pt-6">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted mb-3">Danger zone</h2>
              <div className="flex flex-col gap-3 rounded-xl border border-border p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-foreground">Delete account</p>
                  <p className="text-xs text-muted mt-0.5">
                    Permanently erase your profile, resumes, and every application record.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => { setDeleteConfirmText(""); setDeleteOpen(true); }}
                  className="press shrink-0 rounded-lg border border-danger/50 px-4 py-2 text-sm font-medium text-danger hover:bg-danger/5 transition"
                >
                  Delete account…
                </button>
              </div>
            </div>
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
                No applications yet. Hit <span className="text-foreground">Run now</span> to find your first matches.
              </div>
            ) : (
              <div className="space-y-2">
                {apps.map((a) => (
                  <div
                    key={a.id}
                    className="flex flex-wrap items-start sm:items-center justify-between rounded-xl border border-border bg-surface px-4 py-3 hover:border-brand/40 transition gap-3"
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
                          support reading questions ahead of time — never a fabrication.
                          Shown for "matched" AND "approved" ("To submit") — the kit
                          matters most right when you've clicked Open & submit, not just
                          before it; it must not vanish at exactly that moment. */}
                      {(a.status === "matched" || a.status === "approved") && (a.coverLetterText || a.resumeVersionId) && (
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
                          {/* Extension-aware footer: one-click auto-fill when the
                              extension is here, an optional nudge when it isn't. The
                              copy/paste kit above works regardless. */}
                          {extInstalled ? (
                            <p className="flex items-center gap-1.5 border-t border-border/60 pt-2 text-[11px] text-accent">
                              <span className="size-1.5 rounded-full bg-accent" />
                              Extension active — open this job and click “Fill with Grindly”.
                            </p>
                          ) : (
                            <p className="border-t border-border/60 pt-2 text-[11px] text-muted">
                              One-click auto-fill via the browser extension is{" "}
                              <span className="text-foreground">coming soon</span>. For now, open the
                              listing and use the kit above.
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
                      <span
                        title={STATUS_HELP[a.status] ?? ""}
                        className={`rounded-md px-2 py-1 text-xs ${STATUS_STYLE[a.status] || "bg-surface-2 text-muted"}`}
                      >
                        {sentByAgent(a) ? "Agent sent" : (STATUS_LABEL[a.status] ?? a.status)}
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
                            : "Opens the listing so you can submit it. The agent couldn't send this one itself — the row says why."}
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

        {/* Integrations moved to its own page (/integrations), reached from the
            account menu. It is settings — connect a platform once, then never
            again — and as a tab it sat permanently beside Applications, which is
            what a user actually opens the dashboard for. */}

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

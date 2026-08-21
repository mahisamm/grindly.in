"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type {
  Advice, CompanyPack, CompanyResearch, Fidelity, Report,
} from "@/lib/reportTypes";
import { BAND_LABELS, SHIPPABLE_FLOOR, scoreColor } from "@/lib/reportTypes";
import { isUnlimited } from "@/lib/plans";
import { FidelityLine, Findings, ReportPanel, ScoreDial } from "@/components/Score";
import { RunBanner, useRunStatus } from "./RunProgress";
import { Compare } from "./Compare";
import { CoverLetter } from "./CoverLetter";
import { ProgressPanel, type ApplicationRow, type ScorePoint } from "./Progress";
import { ShareLink } from "./ShareLink";
import { LinkStyleChoice } from "./edit/LinkStyle";
import { UnlockTarget } from "./UnlockTarget";

type VariantView = {
  id: string;
  label: string;
  score: number;
  grade: string;
  baselineScore: number;
  beatsBaseline: boolean;
  pages: number | null;
  targetId: string | null;
  changes: string[];
  report: Report | null;
  fidelity: Fidelity | null;
  /** False for rebuilds made before we started keeping their editable fields. */
  canPromote: boolean;
};

type TargetView = {
  id: string;
  kind: string;
  name: string;
  slug: string | null;
  spec: {
    skills?: string[]; must_have?: string[]; nice_to_have?: string[];
    /** "user" when the text came from the candidate rather than an employer. */
    source?: string;
  } | null;
};

type ResumeView = {
  id: string;
  label: string;
  chars: number;
  /** The document was longer than we read. Everything below describes a part of it. */
  truncated: boolean;
  /** Non-null when a public report link exists for this resume. */
  shareToken: string | null;
  /** "url" (address printed and clickable) or "label" (site name only). */
  linkStyle: string;
  text: string;
  report: Report | null;
  advice: Advice | null;
  skills: string[];
  variants: VariantView[];
  targets: TargetView[];
  history: ScorePoint[];
  applications: ApplicationRow[];
};

type Tab = "report" | "rewrite" | "target" | "progress" | "raw";

const TABS: Tab[] = ["report", "rewrite", "target", "progress", "raw"];

/**
 * Small, official-style marks make the curated list scannable before a user
 * reads a word. They are decorative because the company name stays visible.
 * A graceful two-letter fallback keeps the tile useful if the CDN is offline
 * or a logo changes upstream.
 */
const COMPANY_LOGOS: Record<string, string> = {
  amazon: "amazon.png",
  qualcomm: "qualcomm.svg",
  google: "google.svg",
  microsoft: "microsoft.png",
  tcs: "tcs.svg",
  infosys: "infosys.svg",
  zoho: "zoho.svg",
  flipkart: "flipkart.png",
  deloitte: "deloitte.png",
  accenture: "accenture.svg",
  adobe: "adobe.png",
  netflix: "netflix.svg",
  uber: "uber.svg",
  wipro: "wipro.svg",
  cognizant: "cognizant.png",
  razorpay: "razorpay.svg",
  samsung: "samsung.svg",
};

function companyInitials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

function CompanyLogo({ company }: { company: Pick<CompanyPack, "slug" | "name"> }) {
  const logo = COMPANY_LOGOS[company.slug];
  const src = logo ? `/company-logos/${logo}` : null;
  const [failed, setFailed] = useState(false);

  return (
    <span
      aria-hidden="true"
      className="border-border bg-surface-2 relative grid size-12 shrink-0 place-items-center overflow-hidden rounded-2xl border"
    >
      {(!src || failed) && (
        <span className="font-display text-sm font-bold tracking-tight" style={{ color: "var(--muted)" }}>
          {companyInitials(company.name)}
        </span>
      )}
      {src && !failed && (
        // These small marks ship with the app, rather than making the target
        // picker depend on a third-party image request. The visible company
        // name is the accessible label and initials remain a useful fallback.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          width={32}
          height={32}
          loading="lazy"
          decoding="async"
          className="size-8 object-contain"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

function isTab(value: string | null): value is Tab {
  return TABS.includes((value ?? "") as Tab);
}

export function ResumeWorkspace({
  resume,
  packs,
  disclaimer,
  targetLimit,
  paymentsLive,
}: {
  resume: ResumeView;
  packs: CompanyPack[];
  disclaimer: string;
  /** Company targets this plan allows per resume. */
  targetLimit: number;
  /** False on a stub deployment — the unlock card then says it grants free. */
  paymentsLive: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  /**
   * Which panel is open, kept in the URL rather than in component state.
   *
   * It was `useState`, which meant the back button did not come back, a refresh
   * lost your place, and a link to "look at the rewrites" was impossible to
   * send — every share of this page landed on Readiness no matter what the
   * sender was looking at. An unrecognised value falls back rather than
   * rendering nothing, because this parameter is in a URL anyone can edit.
   */
  const tab: Tab = isTab(params.get("tab")) ? (params.get("tab") as Tab) : "report";

  const setTab = (next: Tab) => {
    const query = new URLSearchParams(params.toString());
    // The default is expressed by absence, so the canonical URL for this page
    // has no query string at all.
    if (next === "report") query.delete("tab");
    else query.set("tab", next);
    const suffix = query.toString();
    // `replace`, not `push`: switching tabs is not navigation and should not
    // fill the back stack with four entries for one page. `scroll: false`
    // because the panel changing under a heading is not a reason to jump the
    // viewport to the top.
    router.replace(suffix ? `${pathname}?${suffix}` : pathname, { scroll: false });
  };
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // The company whose tailoring hit the paywall — the unlock card renders in
  // place of a bare error, because "pay here, then it runs" converts and a
  // trip to the pricing page does not.
  const [lockedTarget, setLockedTarget] = useState<{ id: string; name: string } | null>(null);

  // The rebuild is a row on the server now, so this is the page catching up
  // with it rather than the page owning it. On a cold load it finds a batch
  // that was started before the tab was closed.
  const { run, isRunning, refresh: refreshRun, cancel: cancelRun } = useRunStatus(resume.id);

  async function post(url: string, body?: unknown, label = "working") {
    setBusy(label);
    setError(null);
    setNote(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The paywall answer is an OFFER, not an error: swap the alert strip
        // for the unlock card that completes the purchase in place.
        if (data?.code === "target_locked" && data?.targetId) {
          setLockedTarget({ id: String(data.targetId), name: String(data.targetName ?? "") });
          return null;
        }
        setError(data?.error ?? "That did not work.");
        // A 409 means a batch is already in flight — usually a double click.
        // Picking the run up is more useful than the refusal message.
        if (res.status === 409) void refreshRun();
        return null;
      }
      if (data?.message) setNote(data.message);
      // A 202 hands back a run id rather than results: the work has only just
      // started. Begin watching it instead of refreshing a page that has
      // nothing new on it yet.
      if (data?.runId) void refreshRun();
      else router.refresh();
      return data;
    } catch {
      setError("We could not reach the server.");
      return null;
    } finally {
      setBusy(null);
    }
  }

  // One flag for "a rebuild is happening", whether this tab started it or found
  // it. Every button that would start another one reads this.
  const rebuilding = busy === "rewrite" || isRunning;

  const tabs: [Tab, string][] = [
    ["report", "Readiness"],
    ["rewrite", `Rewrite${resume.variants.length ? ` (${resume.variants.length})` : ""}`],
    ["target", `Target a company${resume.targets.length ? ` (${resume.targets.length})` : ""}`],
    ["progress", `Progress${resume.applications.length ? ` (${resume.applications.length})` : ""}`],
    ["raw", "What the machine reads"],
  ];

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h1 className="font-display min-w-0 text-2xl font-bold break-words sm:text-3xl">
          {resume.label}
        </h1>
        <div className="flex items-center gap-4">
          {resume.report && (
            <span className="text-muted font-mono text-[11px] tracking-[0.1em] whitespace-nowrap uppercase">
              {resume.chars.toLocaleString()} characters read
            </span>
          )}
          {/* The way to act on everything this page says. Without it the report
              names a problem and the only place to fix it is Word. */}
          <Link href={`/app/${resume.id}/edit`} className="btn text-sm">
            Edit
          </Link>
          <DeleteResume id={resume.id} label={resume.label} />
        </div>
      </div>

      {/* The workspace menu. On a laptop it is a fixed left sidebar — the
          place a returning user's eye already checks — and on a phone it is a
          disclosure showing where you are, opening with a height animation
          rather than teleporting. The horizontal strip this replaces sat
          centred in the content column and read as part of the page rather
          than as its navigation. */}
      <div className="mt-6 flex flex-col gap-2 lg:flex-row lg:gap-10">
        <WorkspaceNav tabs={tabs} active={tab} onPick={setTab} />

        <div className="min-w-0 flex-1">
          <RunBanner run={run} onCancel={cancelRun} />

          {lockedTarget && (
            <UnlockTarget
              targetId={lockedTarget.id}
              targetName={lockedTarget.name}
              paymentsLive={paymentsLive}
              onUnlocked={() => {
                const id = lockedTarget.id;
                setLockedTarget(null);
                setNote("Unlocked. Starting the tailored rebuild…");
                void post(`/api/resumes/${resume.id}/variants`, { targetId: id }, "rewrite");
              }}
              onDismiss={() => setLockedTarget(null)}
            />
          )}

          {(error || note) && (
            <p
              role="alert"
              className="mt-5 rounded-lg border p-3 text-sm"
              style={{
                borderColor: error ? "#a3271b" : "var(--border)",
                color: error ? "#a3271b" : "var(--ink-color)",
                background: error ? "transparent" : "var(--surface-2)",
              }}
            >
              {error ?? note}
            </p>
          )}

          {/* All panels exist; the inactive ones are `hidden`.
              Rendering only the selected panel left the other `aria-controls`
              on the tab list pointing at element ids that were not in the
              document. `hidden` keeps them out of the accessibility tree and
              out of the tab order while keeping the id reachable. */}
          <div className="py-6" role="tabpanel" id="panel-report" aria-labelledby="tab-report" hidden={tab !== "report"}>
            <ReportTab
              resume={resume}
              busy={busy}
              onAdvice={() => post(`/api/resumes/${resume.id}/advice`, undefined, "advice")}
            />
          </div>
          <div className="py-6" role="tabpanel" id="panel-rewrite" aria-labelledby="tab-rewrite" hidden={tab !== "rewrite"}>
            <RewriteTab
              resume={resume}
              busy={busy}
              rebuilding={rebuilding}
              onRun={(targetId) =>
                post(`/api/resumes/${resume.id}/variants`, targetId ? { targetId } : {}, "rewrite")
              }
            />
          </div>
          <div className="py-6" role="tabpanel" id="panel-target" aria-labelledby="tab-target" hidden={tab !== "target"}>
            <TargetTab
              resume={resume}
              packs={packs}
              disclaimer={disclaimer}
              targetLimit={targetLimit}
              rebuilding={rebuilding}
              busy={busy}
              onTarget={(body) => post(`/api/resumes/${resume.id}/variants`, body, "rewrite")}
            />
          </div>
          <div className="py-6" role="tabpanel" id="panel-progress" aria-labelledby="tab-progress" hidden={tab !== "progress"}>
            <ProgressPanel
              resumeId={resume.id}
              history={resume.history}
              applications={resume.applications}
              variantLabels={[...new Set(resume.variants.map((v) => v.label))]}
            />
          </div>
          <div className="py-6" role="tabpanel" id="panel-raw" aria-labelledby="tab-raw" hidden={tab !== "raw"}>
            <RawTab resume={resume} />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The workspace's navigation, in the two shapes it needs.
 *
 * From `lg` up: a vertical sidebar, sticky so it stays put while a long panel
 * scrolls — the ARIA tabs pattern with Up/Down arrows, since the list is now
 * vertical. Below `lg`: a disclosure button that names the section you are in
 * and opens with a grid-rows height animation (see `.disclose` in globals) —
 * a dropdown that teleports open reads as a glitch, one that unfolds reads as
 * a menu. The sidebar stays in the DOM on phones (CSS-hidden), so the
 * `tab-${key}` ids the panels' aria-labelledby point at always exist.
 */
function WorkspaceNav({
  tabs,
  active,
  onPick,
}: {
  tabs: [Tab, string][];
  active: Tab;
  onPick: (tab: Tab) => void;
}) {
  const [open, setOpen] = useState(false);
  const activeLabel = tabs.find(([k]) => k === active)?.[1] ?? "";

  return (
    <nav aria-label="Resume workspace sections" className="lg:w-48 lg:shrink-0">
      {/* Phone: the disclosure. */}
      <div className="lg:hidden">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="bg-surface border-border flex w-full cursor-pointer items-center justify-between rounded-xl border px-4 py-3 text-sm font-semibold"
        >
          {activeLabel}
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            className="h-4 w-4 transition-transform duration-200"
            style={{ transform: open ? "rotate(180deg)" : undefined, color: "var(--muted)" }}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <div className={`disclose ${open ? "open" : ""}`}>
          <ul className="min-h-0">
            <li aria-hidden className="h-2" />
            {tabs.map(([key, label]) => (
              <li key={key}>
                <button
                  onClick={() => {
                    onPick(key);
                    setOpen(false);
                  }}
                  aria-current={active === key ? "true" : undefined}
                  className="w-full cursor-pointer rounded-lg px-4 py-2.5 text-left text-sm"
                  style={
                    active === key
                      ? { background: "var(--cta)", color: "var(--on-cta)" }
                      : { color: "var(--muted)" }
                  }
                >
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Laptop: the sidebar. Hidden on phones by CSS, never unmounted — the
          panels' aria-labelledby ids live here. */}
      <div
        className="hidden lg:sticky lg:top-6 lg:block"
        role="tablist"
        aria-orientation="vertical"
      >
        <ul className="space-y-0.5">
          {tabs.map(([key, label]) => (
            <li key={key}>
              <button
                role="tab"
                id={`tab-${key}`}
                aria-selected={active === key}
                aria-controls={`panel-${key}`}
                // Only the selected tab is in the tab order; arrows move the
                // rest — the ARIA tabs pattern, vertical edition.
                tabIndex={active === key ? 0 : -1}
                onKeyDown={(e) => {
                  const i = tabs.findIndex(([k]) => k === active);
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    const next =
                      (i + (e.key === "ArrowDown" ? 1 : tabs.length - 1)) % tabs.length;
                    onPick(tabs[next][0]);
                    document.getElementById(`tab-${tabs[next][0]}`)?.focus();
                  }
                }}
                onClick={() => onPick(key)}
                className="w-full cursor-pointer rounded-lg px-3 py-2 text-left text-sm whitespace-nowrap transition-colors"
                style={
                  active === key
                    ? { background: "var(--cta)", color: "var(--on-cta)" }
                    : { color: "var(--muted)" }
                }
              >
                {label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

/**
 * Delete this resume.
 *
 * The endpoint existed for a while with nothing calling it, while the uploader
 * told a capped free user to "delete one or get a Season Pass" and the privacy
 * policy claimed deletion as a right. The only real option was to pay.
 *
 * Two-step rather than a `confirm()` dialog: the browser's is unstyleable, is
 * suppressed by some browsers after repeated use, and reads as a bug on a page
 * that otherwise has its own visual language.
 */
function DeleteResume({ id, label }: { id: string; label: string }) {
  const router = useRouter();
  const [arming, setArming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/resumes/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? "Could not delete it.");
        setBusy(false);
        return;
      }
      router.push("/app");
      router.refresh();
    } catch {
      setError("We could not reach the server.");
      setBusy(false);
    }
  }

  if (!arming) {
    return (
      <button
        onClick={() => setArming(true)}
        className="text-muted hover:text-ink text-sm underline"
      >
        Delete
      </button>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted">Delete &ldquo;{label}&rdquo; and its rewrites?</span>
      <button
        onClick={remove}
        disabled={busy}
        className="rounded px-2 py-1 text-xs font-medium"
        style={{ background: "#a3271b", color: "var(--on-cta)" }}
      >
        {busy ? "Deleting…" : "Yes, delete"}
      </button>
      <button onClick={() => setArming(false)} className="text-muted underline">
        Cancel
      </button>
      {error && <span style={{ color: "#a3271b" }}>{error}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------

/**
 * The readiness tab, opened in three acts.
 *
 * User reviews kept saying the same thing: a full report sitting on the left
 * that nobody asked for, next to a button offering "a review" — so the button
 * read as a second, human reviewer. One reviewer, one entry point. Act one is
 * a single card with a single press. Act two is the reading: a scan beam over
 * a skeleton sheet while the real band results tick in (ReadingScene). Act
 * three is the settle: the dial counts up, the bars grow, and the aside —
 * model card, then share, then skills — arrives after the score, not beside
 * it. (An earlier act two flew the button across to the aside; testers
 * watched the button land on the right while the report appeared unannounced
 * on the left. The star of this reveal is the report.)
 *
 * Two rules keep the theatre honest. The report is NEVER gated on the model:
 * the score is arithmetic, already computed at upload, and it reveals even if
 * every LLM provider is down or the advice quota is spent — the reading scene
 * shows real measured sub-scores while the one genuine in-flight call (the
 * model's advice) runs. And the curtain only falls once: advice existing in
 * the database (any device) or a localStorage mark (this device, covering the
 * case where the advice call failed) means the tab opens straight onto the
 * report forever after.
 */
function ReportTab({
  resume,
  busy,
  onAdvice,
}: {
  resume: ResumeView;
  busy: string | null;
  onAdvice: () => void;
}) {
  const seenKey = `grindly:report-seen:${resume.id}`;
  // Whether THIS browser has opened the report before. useSyncExternalStore
  // rather than an effect: the server snapshot says "not seen" (the server
  // cannot know), the client snapshot reads localStorage, and React reconciles
  // the two at hydration without a flash or a cascading set-state.
  const seenBefore = useSyncExternalStore(
    noopSubscribe,
    () => {
      try {
        return localStorage.getItem(seenKey) !== null;
      } catch {
        return false; // blocked storage just means the curtain shows again
      }
    },
    () => false,
  );
  const [opened, setOpened] = useState<"no" | "reading" | "yes">("no");
  // Whether the settled layout should perform its entrance. "cinematic" only
  // ever follows the reading scene; a return visit is "none" — everything is
  // simply there, the way it was left.
  const [entrance, setEntrance] = useState<"none" | "cinematic">("none");

  // Advice in the database means any device has seen it; the localStorage
  // mark covers this device when the advice call failed or is still running.
  const gated = !resume.advice && !seenBefore && opened === "no";

  function reveal() {
    try {
      localStorage.setItem(seenKey, "1");
    } catch {
      /* the gate returns next visit; nothing worse */
    }
    // Fired first, so the model genuinely IS reading for every second the
    // reading scene is on screen — the scene narrates a real call in flight,
    // never a simulated one.
    onAdvice();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setOpened("yes");
      return;
    }
    setEntrance("cinematic");
    setOpened("reading");
  }

  // Stable across renders: the reading scene keys its auto-advance timer on
  // this, and the advice call resolving mid-scene re-renders this component —
  // a fresh closure each render would restart the clock at every refresh.
  const settle = useCallback(() => setOpened("yes"), []);

  if (!resume.report) {
    return (
      <p className="text-muted text-sm">
        We stored this file but could not read a report from it. Try uploading the
        original PDF rather than a scan or a screenshot.
      </p>
    );
  }

  if (gated) {
    return (
      <div className="mx-auto max-w-xl py-10 text-center sm:py-16">
        <h2 className="font-display text-2xl font-semibold sm:text-3xl">
          Your report is ready
        </h2>
        <p className="text-muted mx-auto mt-3 max-w-md text-sm leading-relaxed">
          The score is already measured — arithmetic over your text, not opinion.
          One press opens it, and asks a model for its read on the writing: what
          works, what is weak, what to do. It never produces a number and it can
          never invent a fact you did not claim.
        </p>
        <button
          onClick={reveal}
          disabled={busy !== null}
          className="btn btn-primary mt-6 min-w-52 justify-center"
        >
          Ask for a review
        </button>
      </div>
    );
  }

  if (opened === "reading") {
    return <ReadingScene report={resume.report} onDone={settle} />;
  }

  // Entrance timing for each panel, as a spreadable prop bundle. `none` means
  // a return visit: everything is simply there, the way it was left.
  const rise = (ms: number) =>
    entrance === "none"
      ? {}
      : {
          className: "report-reveal",
          style: { "--reveal-at": `${ms}ms` } as React.CSSProperties,
        };

  return (
    <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr]">
      <div {...rise(0)}>
        {/* Said before the score, not after it. Every number on this page
            describes the first 60 000 characters of a longer document, and a
            partial reading presented as a complete one is the one thing this
            product cannot do. */}
        {resume.truncated && (
          <div
            className="mb-6 rounded-lg border p-3 text-sm leading-snug"
            style={{ borderColor: "var(--warn)", background: "var(--surface-2)" }}
          >
            <p className="font-medium">This resume is longer than we read.</p>
            <p className="text-muted mt-1">
              We measure the first 60,000 characters — about fifteen pages. Everything
              below describes that much of it. If your file is that long, the more
              useful fact is that no recruiter reads past page two either.
            </p>
          </div>
        )}
        {/* The dial counts up and the bars grow only on the cinematic
            entrance — a return visit renders the finished fact. */}
        <ReportPanel report={resume.report} animate={entrance === "cinematic"} />
      </div>
      <aside>
        <div {...rise(700)}>
          {resume.advice ? (
            // The box, the heading and the disclaimer only earn their place
            // once there is a real opinion inside them to qualify.
            <div className="bg-surface border-border rounded-xl border p-5">
              <h3 className="font-display text-lg font-semibold">Model&rsquo;s read</h3>
              <p className="text-muted mt-1.5 text-sm leading-snug">
                The score above is arithmetic. This is a model&rsquo;s opinion on the writing —
                it never produces a number and it can never suggest a fact you did not
                already claim.
              </p>
              <div className="mt-4 flex flex-col gap-4 text-sm">
                <AdviceList title="Working" items={resume.advice.strengths} />
                <AdviceList title="Weak" items={resume.advice.issues} />
                <AdviceList title="Do this" items={resume.advice.suggestions} />
              </div>
            </div>
          ) : busy === "advice" ? (
            // The one press already happened at the gate — no second "Ask for
            // a review" ever appears once the report is on screen. While the
            // call is in flight this is a status, not an offer.
            <div className="bg-surface border-border rounded-xl border p-5">
              <h3 className="font-display text-lg font-semibold">Model&rsquo;s read</h3>
              <p className="text-muted mt-1.5 text-sm leading-snug">
                The model is reading your resume now — its notes on the writing will
                appear here in a few seconds.
              </p>
            </div>
          ) : (
            // The call failed or never landed (a provider outage, a spent
            // quota, a legacy reveal). A quiet retry line, not a call to
            // action — testers read a second big button as a second product.
            <p className="text-muted text-sm leading-snug">
              The model&rsquo;s notes on the writing did not arrive.{" "}
              <button onClick={onAdvice} className="text-brand cursor-pointer underline">
                Try again
              </button>
            </p>
          )}
        </div>

        <div {...rise(900)}>
          <ShareLink resumeId={resume.id} initialToken={resume.shareToken} />
        </div>

        {resume.skills.length > 0 && (
          <div {...rise(1080)}>
            <div className="bg-surface border-border mt-4 rounded-xl border p-5">
              <h3 className="font-display text-lg font-semibold">Skills we found</h3>
              <p className="text-muted mt-1.5 text-xs leading-snug">
                A rewrite may surface these. It cannot introduce a technology, employer,
                date or number that is not somewhere in your resume.
              </p>
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {resume.skills.map((s) => (
                  <li
                    key={s}
                    className="bg-surface-2 border-border rounded border px-2 py-0.5 font-mono text-[11px]"
                  >
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

/** For useSyncExternalStore over a value that never changes underneath us:
 *  localStorage is only ever written by our own click handler, which re-renders
 *  anyway, so there is nothing to subscribe to. */
const noopSubscribe = () => () => {};

/**
 * The moment between the press and the report: your resume, being read.
 *
 * A scan beam sweeps a skeleton sheet while the four band results tick in one
 * at a time — each line is the REAL measured sub-score, not a progress bar
 * over pretend work, and the model's advice call genuinely is in flight for
 * every second this is on screen (reveal() fires it before showing this).
 * The first version of this reveal flew the button across to the aside
 * instead, and testers watched the button land on the right while the
 * report — the actual star — appeared unannounced on the left.
 *
 * Auto-advances on a timer rather than `animationend`, which never fires in a
 * backgrounded tab — a stuck curtain over a report someone asked to see is
 * the one failure this must not have. The skip link is for the second upload,
 * when the theatre is no longer news.
 */
function ReadingScene({ report, onDone }: { report: Report; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, 3400);
    return () => clearTimeout(timer);
  }, [onDone]);

  const entries = Object.entries(report.bands);

  return (
    <div className="mx-auto max-w-md py-8 text-center sm:py-12">
      <h2 className="font-display text-xl font-semibold sm:text-2xl">
        Reading your resume…
      </h2>
      <p className="text-muted mt-2 text-sm leading-snug">
        The way a recruiter&rsquo;s software reads it — while a model reads the writing.
      </p>

      {/* The sheet is decoration and says so; the band lines below are the
          data and are real text. */}
      <div
        aria-hidden
        className="bg-surface border-border relative mx-auto mt-6 h-44 w-full max-w-xs overflow-hidden rounded-xl border p-5"
      >
        <div className="flex h-full flex-col gap-2.5">
          {[82, 46, 68, 90, 58, 74, 40].map((w, i) => (
            <div key={i} className="bg-surface-2 h-2.5 rounded" style={{ width: `${w}%` }} />
          ))}
        </div>
        <div className="scan-beam" />
      </div>

      <ul className="mx-auto mt-5 flex max-w-xs flex-col gap-2 text-left">
        {entries.map(([key, band], i) => (
          <li
            key={key}
            className="report-reveal flex items-baseline justify-between gap-3 text-sm"
            style={{ "--reveal-at": `${500 + i * 620}ms` } as React.CSSProperties}
          >
            <span>{BAND_LABELS[key] ?? key}</span>
            <span className="font-mono text-xs tabular-nums" style={{ color: scoreColor(band.score) }}>
              {band.score} / 100
            </span>
          </li>
        ))}
      </ul>

      <button
        onClick={onDone}
        className="text-muted hover:text-ink mt-6 cursor-pointer text-xs underline"
      >
        Show the report now
      </button>
    </div>
  );
}

function AdviceList({ title, items }: { title: string; items: string[] }) {
  if (!items?.length) return null;
  return (
    <div>
      <p className="font-mono text-[10px] tracking-[0.14em] uppercase opacity-60">{title}</p>
      <ul className="mt-1.5 list-disc space-y-1 pl-4 leading-snug">
        {items.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </div>
  );
}

function RewriteTab({
  resume,
  busy,
  rebuilding,
  onRun,
}: {
  resume: ResumeView;
  busy: string | null;
  /** A batch is in flight — this tab's, another tab's, or one from before. */
  rebuilding: boolean;
  onRun: (targetId: string | null) => void;
}) {
  const untargeted = resume.variants.filter((v) => !v.targetId);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h2 className="font-display text-2xl font-semibold">Rebuild your resume</h2>
          {/* Plain words on purpose — beta feedback called this tab confusing.
              The mechanism (render, extract back, score) still matters, but it
              belongs one sentence deep, after "what does the button do". */}
          <p className="text-muted mt-2 leading-relaxed">
            One press writes up to three new versions of your resume — same facts,
            same jobs, cleaner wording, and a layout that hiring software reads
            without mistakes. It takes a minute or two.
          </p>
          <p className="text-muted mt-2 leading-relaxed">
            Every version gets the same 0–100 score as your original (the one on
            your Readiness tab), so you can see whether it is actually better. A
            version that scores <i>worse</i> than yours is thrown away instead of
            shown to you. We aim for {SHIPPABLE_FLOOR} and above — and when a
            version lands short, its card tells you the one thing that is missing.
          </p>
          <p className="text-muted mt-2 leading-relaxed">
            One promise above all: it will never invent a skill, an employer or a
            number that is not already in your resume.
          </p>
        </div>
        <button onClick={() => onRun(null)} disabled={busy !== null || rebuilding} className="btn btn-primary">
          {rebuilding ? "Rebuilding…" : untargeted.length ? "Run again" : "Rebuild my resume"}
        </button>
      </div>

      {/* The choice belongs BEFORE the run, where it takes effect — the same
          control also lives on the edit page, but a setting that changes what
          the next rebuild prints must be visible at the moment of rebuilding,
          not remembered from another screen. It carries its own measured
          warning: "label" hides the address from every parser. */}
      <div className="max-w-2xl">
        <LinkStyleChoice resumeId={resume.id} value={resume.linkStyle} />
      </div>

      {untargeted.length === 0 ? (
        <p className="text-muted mt-8 text-sm">No versions yet — press the button above and give it a minute or two. Your original is never touched.</p>
      ) : (
        <ul className="mt-8 grid gap-5 lg:grid-cols-3">
          {untargeted.map((v) => (
            <VariantCard
              key={v.id}
              variant={v}
              baseline={resume.report}
              originalText={resume.text}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function VariantCard({
  variant,
  baseline,
  originalText,
}: {
  variant: VariantView;
  /** The user's own resume, for the side-by-side. */
  baseline: Report | null;
  originalText: string;
}) {
  const [comparing, setComparing] = useState(false);
  const delta = variant.score - variant.baselineScore;
  // Derived from the score rather than stored, so it can never disagree with
  // the number printed beside it. SHIPPABLE_FLOOR mirrors the Python constant.
  const belowFloor = variant.score < SHIPPABLE_FLOOR;
  // The one thing standing between this rebuild and the floor. Taken from the
  // report the card already has, so it is the same sentence whether the page
  // was just refreshed or loaded cold.
  const blocker = belowFloor
    ? variant.report?.findings?.[0]?.fix ?? variant.report?.findings?.[0]?.problem ?? ""
    : "";

  return (
    <li className="bg-surface border-border flex flex-col rounded-xl border p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-lg leading-tight font-semibold">{variant.label}</h3>
          <p className="text-muted mt-1 font-mono text-[11px] tracking-[0.08em] uppercase">
            {delta > 0 ? `+${delta} vs your original` : "level with your original"}
            {variant.pages ? ` · ${variant.pages} page${variant.pages === 1 ? "" : "s"}` : ""}
          </p>
        </div>
        <ScoreDial score={variant.score} grade={variant.grade} size={72} />
      </div>

      {belowFloor && (
        <div
          className="mt-4 rounded-lg border p-3 text-sm leading-snug"
          style={{ borderColor: "#a8730f", background: "var(--surface-2)" }}
        >
          <p className="font-medium">
            Under {SHIPPABLE_FLOOR} — one thing is missing, and it is not the layout.
          </p>
          <p className="text-muted mt-1">
            {blocker ||
              "The rebuild parses cleanly; what it needs now is content only you can supply."}
          </p>
        </div>
      )}

      {variant.changes.length > 0 && (
        <ul className="text-muted mt-4 list-disc space-y-1 pl-4 text-sm leading-snug">
          {variant.changes.slice(0, 4).map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      )}

      <div className="mt-4">
        <FidelityLine fidelity={variant.fidelity} />
      </div>

      <div className="mt-auto flex flex-wrap gap-2 pt-5">
        <a
          href={`/api/variants/${variant.id}/file`}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-primary flex-1 justify-center text-sm"
        >
          Open PDF
        </a>
        {/* Separate from "Open PDF", because they are different intentions and
            the file arrives named differently depending on which one you meant.
            Opening is for looking; saving is the one that lands in a folder and
            gets attached to an email, so it is the one that has to come out as
            Zoho-Your-Name-Resume.pdf. */}
        <a
          href={`/api/variants/${variant.id}/file?download=1`}
          download
          className="btn justify-center text-sm"
        >
          Download
        </a>
        <button
          onClick={() => setComparing((v) => !v)}
          aria-expanded={comparing}
          className="btn justify-center text-sm"
        >
          {comparing ? "Hide" : "Compare"}
        </button>
      </div>

      {variant.canPromote && <Promote variantId={variant.id} />}

      {/* Expanded inside the card rather than in a modal: the comparison is the
          evidence for the number printed six inches above it, and putting it
          behind an overlay separates the claim from its proof. */}
      {comparing && (
        <div className="border-border mt-5 border-t pt-5">
          <Compare
            baseline={baseline}
            baselineLabel="Your resume"
            variantLabel={variant.label}
            variantReport={variant.report}
            variantFidelity={variant.fidelity}
            variantId={variant.id}
            originalText={originalText}
          />
        </div>
      )}
    </li>
  );
}

/**
 * "Use as my resume."
 *
 * The sentence under the button is the feature. Every tool in this category has
 * a button here and none of them say what it does to the document you already
 * have, so the safe assumption — the one people actually make — is that pressing
 * it replaces something. It does not: the rebuild is saved as a document of its
 * own and the account's pointer moves, which means the way back is another
 * button rather than a support request. Saying so costs one line and is the
 * difference between a button people press and one they hover over and leave.
 *
 * Navigates to the new resume on success. The thing just created is the thing
 * they were promised, and leaving them on the card they pressed makes them go
 * looking for it.
 */
function Promote({ variantId }: { variantId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function promote() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/variants/${variantId}/promote`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "That did not work.");
        return;
      }
      router.push(`/app/${data.id}`);
    } catch {
      setError("We could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-border mt-4 border-t pt-4">
      <button
        onClick={() => void promote()}
        disabled={busy}
        className="btn w-full justify-center text-sm"
      >
        {busy ? "Saving…" : "Use as my resume"}
      </button>
      <p className="text-muted mt-2 text-xs leading-relaxed">
        Saves this as a resume of its own and makes it the one you are sending
        out. Your original stays exactly where it is — with its score, its
        targets and everything you have logged against it — and you can
        switch back from the resume list.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-xs" style={{ color: "#a3271b" }}>
          {error}
        </p>
      )}
    </div>
  );
}

function TargetTab({
  resume,
  packs,
  disclaimer,
  targetLimit,
  busy,
  rebuilding,
  onTarget,
}: {
  resume: ResumeView;
  packs: CompanyPack[];
  disclaimer: string;
  targetLimit: number;
  busy: string | null;
  rebuilding: boolean;
  onTarget: (body: Record<string, string>) => void;
}) {
  const [jd, setJd] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  // One box drives everything on this tab: it live-filters the curated packs
  // as you type, and submitting it looks any other company up. It sits at the
  // top because users typed a company into their heads before they arrived —
  // making them scroll past ten cards to find the box taught them the cards
  // were the whole feature.
  const [query, setQuery] = useState("");

  // Said up front rather than discovered by hitting a 402. Aiming at a company
  // the resume is already aimed at reuses that target and costs nothing more,
  // so the count is of NEW targets left, not of clicks left.
  const unlimited = isUnlimited(targetLimit);
  const used = resume.targets.length;
  const left = Math.max(0, targetLimit - used);

  const q = query.trim().toLowerCase();
  const shownPacks = q
    ? packs.filter(
        (p) => p.name.toLowerCase().includes(q) || p.summary.toLowerCase().includes(q),
      )
    : packs;

  return (
    <div className="flex flex-col gap-10">
      <section>
        <h2 className="font-display text-2xl font-semibold">Aim it at a company</h2>
        <p className="text-muted mt-2 max-w-2xl leading-relaxed">
          Each pack is what the employer has published about how it hires, with the link so
          you can check. Targeting changes what your resume <i>surfaces</i> — it can never
          add a skill, a date or a number you did not already have.
        </p>

        <AnyCompany
          resume={resume}
          busy={busy}
          rebuilding={rebuilding}
          onTarget={onTarget}
          targetsLeft={left}
          query={query}
          onQueryChange={setQuery}
        />
        <p className="mt-3 max-w-2xl text-sm">
          {unlimited ? (
            <span className="text-muted">
              No limit on targets for this account.
            </span>
          ) : left > 0 ? (
            <span className="text-muted">
              {left} of {targetLimit} target{targetLimit === 1 ? "" : "s"} left on this
              resume. Re-running one you have already set up is free.
            </span>
          ) : (
            <span>
              You have used all {targetLimit} target{targetLimit === 1 ? "" : "s"} your plan
              allows on this resume. You can still re-run the ones below.{" "}
              <a href="/pricing" className="text-brand underline">
                A Season Pass raises it
              </a>
              .
            </span>
          )}
        </p>

        {q && shownPacks.length === 0 && (
          <p className="text-muted mt-6 text-sm">
            No curated pack matches &ldquo;{query.trim()}&rdquo; — press{" "}
            <b>Look it up</b> above and we will tell you what we actually know.
          </p>
        )}
        <div className="mt-7 flex items-center justify-between gap-4">
          <h3 className="font-display text-base font-semibold">Popular company packs</h3>
          <span className="text-muted font-mono text-[10px] tracking-[0.12em] uppercase">
            {shownPacks.length} curated
          </span>
        </div>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shownPacks.map((p) => {
            const existing = resume.targets.find((t) => t.slug === p.slug);
            const variants = existing
              ? resume.variants.filter((v) => v.targetId === existing.id)
              : [];
            return (
              // flex-col with the action pushed to the bottom: the summaries
              // are two to four lines long, so without it every button in a row
              // sits at a different height and the grid reads as broken.
              <li
                key={p.slug}
                className="bg-surface border-border group flex min-h-60 flex-col rounded-2xl border p-4 transition-[border-color,transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-lg"
              >
                <div className="flex items-center gap-3">
                  <CompanyLogo company={p} />
                  <div className="min-w-0">
                    <h3 className="font-display truncate text-lg font-semibold">{p.name}</h3>
                    <p className="text-muted mt-0.5 font-mono text-[10px] tracking-[0.1em] uppercase">
                      {p.best_for.slice(0, 2).join(" · ")}
                    </p>
                  </div>
                </div>
                <p className="text-muted mt-4 text-sm leading-snug">{p.summary}</p>

                <button
                  onClick={() => setOpen(open === p.slug ? null : p.slug)}
                  className="text-muted hover:text-ink mt-3 w-fit text-xs underline underline-offset-4"
                >
                  {open === p.slug
                    ? "Hide sources"
                    : `${p.sources.length} source${p.sources.length === 1 ? "" : "s"}`}
                </button>
                {open === p.slug && (
                  <ul className="mt-2 space-y-2 text-xs leading-snug">
                    {p.sources.map((s) => (
                      <li key={s.url}>
                        <p>{s.claim}</p>
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer nofollow"
                          className="text-brand break-all underline"
                        >
                          {s.url}
                        </a>
                        <span className="text-muted block">Checked {s.curated_on}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {variants.length > 0 && (
                  <ul className="mt-4 space-y-1.5">
                    {variants.map((v) => (
                      <li key={v.id} className="flex items-center justify-between gap-2 text-sm">
                        <span>{v.label}</span>
                        <a
                          href={`/api/variants/${v.id}/file`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-brand text-xs underline"
                        >
                          {v.score} · open
                        </a>
                      </li>
                    ))}
                  </ul>
                )}

                {/* mt-auto on the WRAPPER, not the button: the auto margin
                    takes up the slack so every card's action sits on the same
                    line, and pt-4 keeps a real gap on the tallest card, where
                    there is no slack left to take up. */}
                <div className="mt-auto pt-4">
                  <button
                    onClick={() =>
                      onTarget(existing ? { targetId: existing.id } : { company: p.slug })
                    }
                    // Disabled rather than allowed-and-then-refused. Setting up
                    // a NEW target is what the plan caps; re-running one that
                    // already exists is always available.
                    disabled={busy !== null || rebuilding || (!existing && left === 0)}
                    title={!existing && left === 0 ? "No targets left on this resume" : undefined}
                    className="btn w-full justify-center text-sm"
                  >
                    {rebuilding
                      ? "Working…"
                      : variants.length
                        ? "Rebuild"
                        : !existing && left === 0
                          ? "No targets left"
                          : "Tailor for " + p.name}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
        <p className="text-muted mt-6 max-w-3xl text-xs leading-relaxed">{disclaimer}</p>
      </section>

      <section className="border-border border-t pt-10">
        <h2 className="font-display text-2xl font-semibold">Or paste a job description</h2>
        <p className="text-muted mt-2 max-w-2xl leading-relaxed">
          For any role not in the list. We read the requirements out of it, score your
          resume against them, and tell you what is missing — we never add it for you.
        </p>
        {/* A placeholder is not a label: it disappears on first keystroke and
            screen readers are inconsistent about announcing it at all. */}
        <label htmlFor="jd-text" className="sr-only">
          Job description
        </label>
        <textarea
          id="jd-text"
          value={jd}
          onChange={(e) => setJd(e.target.value)}
          rows={8}
          placeholder="Paste the full job description here…"
          className="field mt-5 w-full font-mono text-sm"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            onClick={() => onTarget({ jd })}
            disabled={busy !== null || rebuilding || jd.trim().length < 60}
            className="btn btn-primary"
          >
            {rebuilding ? "Working…" : "Tailor to this role"}
          </button>
          <span className="text-muted text-xs">
            {jd.trim().length < 60
              ? "Paste at least a paragraph."
              : `${jd.trim().length.toLocaleString()} characters`}
          </span>
        </div>

        {resume.targets
          // Notes sit here too: both are "text someone pasted, parsed for
          // requirements", and the only difference is who wrote it — which the
          // panel says out loud rather than hiding by keeping them apart.
          .filter((t) => t.kind === "jd" || t.kind === "notes")
          .map((t) => {
            const variants = resume.variants.filter((v) => v.targetId === t.id);
            const required = t.spec?.skills ?? [];
            // The gap, actually computed — the panel used to name a variable
            // `missing`, fill it with EVERY requirement, and print it under a
            // heading promising to say what was missing.
            const have = new Set(resume.skills.map((s) => s.toLowerCase()));
            const resumeText = resume.text.toLowerCase();
            const gaps = required.filter(
              (s) => !have.has(s.toLowerCase()) && !resumeText.includes(s.toLowerCase()),
            );
            return (
              <div key={t.id} className="bg-surface border-border mt-6 rounded-xl border p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="font-display text-lg font-semibold">{t.name}</h3>
                  {t.kind === "notes" && (
                    <span
                      className="rounded px-2 py-0.5 font-mono text-[10px] tracking-[0.12em] uppercase"
                      style={{ background: "var(--surface-2)", color: "var(--muted)" }}
                    >
                      from you · not verified
                    </span>
                  )}
                </div>
                {t.kind === "notes" && (
                  <p className="text-muted mt-1.5 text-xs leading-relaxed">
                    Read out of what you wrote about {t.name}. We have not checked any
                    of it and we are not treating it as something the company published
                    — it decides which of your own skills get surfaced, nothing more.
                  </p>
                )}
                {required.length > 0 && (
                  <p className="text-muted mt-2 text-sm">
                    Requirements read: {required.join(", ")}
                  </p>
                )}
                {gaps.length > 0 ? (
                  <div className="border-border mt-3 rounded-lg border p-3 text-sm">
                    <p className="font-medium">
                      Not visible on your resume: {gaps.join(", ")}
                    </p>
                    <p className="text-muted mt-1 leading-snug">
                      If you have any of these, add them yourself in a bullet or in
                      Technical Skills — a recruiter searches for the exact word. If you
                      do not, leave them off. We will never add them for you.
                    </p>
                  </div>
                ) : required.length > 0 ? (
                  <p className="mt-3 text-sm">
                    Your resume already shows every requirement we could read.
                  </p>
                ) : null}
                {variants.length > 0 && (
                  <ul className="mt-3 grid gap-3 sm:grid-cols-3">
                    {variants.map((v) => (
                      <VariantCard
                        key={v.id}
                        variant={v}
                        baseline={resume.report}
                        originalText={resume.text}
                      />
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
      </section>

      <CoverLetter
        resumeId={resume.id}
        targets={resume.targets.map((t) => ({ id: t.id, name: t.name }))}
      />
    </div>
  );
}

/**
 * Target any employer, curated or not.
 *
 * Ten packs is not a company list, it is a demo. This is the section that makes
 * the feature real for the other few million employers, and its most important
 * behaviour is the one that does nothing: for most companies there is nothing
 * specific and checkable to say about how they screen, and it says so instead
 * of generating a confident paragraph. See agent/company_research.py.
 *
 * The lookup is free and writes nothing. Only the "tailor" button spends a run,
 * so a user can find out that tailoring will not help them without paying for
 * the privilege.
 */
function AnyCompany({
  resume,
  busy,
  rebuilding,
  onTarget,
  targetsLeft,
  query,
  onQueryChange,
}: {
  resume: ResumeView;
  busy: string | null;
  rebuilding: boolean;
  onTarget: (body: Record<string, string>) => void;
  /** New company targets this plan still allows on this resume. */
  targetsLeft: number;
  /** Owned by TargetTab: the same text live-filters the curated packs below. */
  query: string;
  onQueryChange: (value: string) => void;
}) {
  const [looking, setLooking] = useState(false);
  const [found, setFound] = useState<CompanyResearch | null>(null);
  const [error, setError] = useState<string | null>(null);

  const existing = found
    ? resume.targets.find((t) => t.name.toLowerCase() === found.name.toLowerCase())
    : undefined;

  async function look() {
    const typed = query.trim();
    if (typed.length < 2) return;
    setLooking(true);
    setError(null);
    setFound(null);
    try {
      const res = await fetch("/api/companies/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: typed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "That lookup did not work.");
        return;
      }
      setFound(data as CompanyResearch);
    } catch {
      setError("We could not reach the server.");
    } finally {
      setLooking(false);
    }
  }

  return (
    <div className="mt-5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          look();
        }}
        className="flex max-w-2xl flex-wrap items-center gap-3"
      >
        {/* The one search box for the whole tab. Typing filters the curated
            packs below it live; submitting looks anything else up. Deliberately
            set larger than an ordinary field — it is the tab's front door. */}
        <label className="relative min-w-[16rem] flex-1">
          <span className="sr-only">Company name</span>
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            className="pointer-events-none absolute top-1/2 left-4 h-4.5 w-4.5 -translate-y-1/2"
            style={{ color: "var(--muted)" }}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.2-3.2" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            maxLength={80}
            placeholder="Type any company — Freshworks, Zoho, a 40-person startup…"
            className="bg-surface border-border w-full rounded-full border py-3 pr-5 pl-11 text-base shadow-sm transition-shadow focus:shadow-md focus:outline-2"
            style={{ outlineColor: "var(--cta)" }}
          />
        </label>
        <button
          type="submit"
          disabled={looking || query.trim().length < 2}
          className="btn btn-primary"
        >
          {looking ? "Looking…" : "Look it up"}
        </button>
      </form>
      <p className="text-muted mt-2 text-xs leading-relaxed">
        Typing filters the packs below. Anything else, look it up — we say what we
        actually know about how they screen, and when the honest answer is
        &ldquo;nothing specific&rdquo;, you get that instead of a paragraph we made up.
      </p>

      {error && (
        <p role="alert" className="mt-4 text-sm" style={{ color: "#a3271b" }}>
          {error}
        </p>
      )}

      {found && (
        <div className="bg-surface border-border mt-6 rounded-xl border p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h3 className="font-display text-lg font-semibold">{found.name}</h3>
            <span
              className="rounded px-2 py-0.5 font-mono text-[10px] tracking-[0.12em] uppercase"
              style={{
                background: "var(--surface-2)",
                color: found.tailoring === "curated" ? "var(--brand)" : "var(--muted)",
              }}
            >
              {found.tailoring === "curated"
                ? "curated · sources checked"
                : found.tailoring === "generated"
                  ? "generated · no sources"
                  : "no tailoring needed"}
            </span>
          </div>

          {found.summary && <p className="mt-2 text-sm leading-relaxed">{found.summary}</p>}

          {found.tailoring === "not_required" ? (
            <>
              <p className="text-muted mt-3 text-sm leading-relaxed">{found.note}</p>
              {/* The next step, here, rather than a sentence pointing at one.
                  "Paste their posting below" meant scrolling past ten company
                  cards to find the box — so the honest answer read as a dead
                  end, which is exactly what it is not. */}
              <SupplyEvidence
                company={found.name}
                busy={busy}
                rebuilding={rebuilding}
                disabled={!existing && targetsLeft === 0}
                onTarget={onTarget}
              />
            </>
          ) : (
            <>
              {found.emphasis.length > 0 && (
                <ul className="mt-3 list-disc space-y-1 pl-4 text-sm leading-snug">
                  {found.emphasis.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
              {found.keywords.length > 0 && (
                <ul className="mt-3 flex flex-wrap gap-1.5">
                  {found.keywords.map((k) => (
                    <li
                      key={k}
                      className="bg-surface-2 border-border rounded border px-2 py-0.5 font-mono text-[11px]"
                    >
                      {k}
                    </li>
                  ))}
                </ul>
              )}
              {found.note && (
                <p className="text-muted mt-4 text-xs leading-relaxed">{found.note}</p>
              )}
              <button
                onClick={() =>
                  onTarget(
                    existing ? { targetId: existing.id } : { companyName: found.name },
                  )
                }
                disabled={busy !== null || rebuilding || (!existing && targetsLeft === 0)}
                className="btn btn-primary mt-5"
              >
                {rebuilding
                  ? "Working…"
                  : !existing && targetsLeft === 0
                    ? "No targets left on this resume"
                    : `Tailor for ${found.name}`}
              </button>
              {!existing && targetsLeft === 0 && (
                <p className="text-muted mt-2 text-xs">
                  Looking a company up is always free — it is aiming your resume at a
                  new one that your plan limits.{" "}
                  <a href="/pricing" className="text-brand underline">See plans</a>.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Two ways to target a company we know nothing about, offered where the
 * "we know nothing" answer is given.
 *
 * The first is their job posting, which is strictly better evidence than
 * anything we could have said: the employer wrote it, it is current, and it is
 * about the role rather than the company.
 *
 * The second is what the USER knows — a conversation with someone who works
 * there, a Glassdoor thread, an alumni tip. It is stored and labelled as
 * theirs, never as ours, and that distinction is the whole design. Reading
 * forum threads ourselves and presenting the result as knowledge would make
 * every "each claim links to the company's own page" promise on this page
 * untrue. Their own anecdote is their risk to weigh; the same anecdote
 * laundered through us would be a claim we cannot stand behind.
 */
function SupplyEvidence({
  company,
  busy,
  rebuilding,
  disabled,
  onTarget,
}: {
  company: string;
  busy: string | null;
  rebuilding: boolean;
  disabled: boolean;
  onTarget: (body: Record<string, string>) => void;
}) {
  const [kind, setKind] = useState<"jd" | "notes">("jd");
  const [text, setText] = useState("");

  const min = kind === "jd" ? 60 : 40;
  const short = text.trim().length < min;

  return (
    <div className="border-border mt-5 border-t pt-5">
      <p className="text-sm font-medium">Give it something to work with</p>

      <div className="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label="What you have">
        {([
          ["jd", "Their job posting"],
          ["notes", "What you know about them"],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={kind === value}
            onClick={() => setKind(value)}
            className="cursor-pointer rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors"
            style={{
              borderColor: kind === value ? "var(--vermilion)" : "var(--line-2)",
              // See Compare.tsx: 12px label, so --cta rather than --vermilion.
              background: kind === value ? "var(--cta)" : "transparent",
              color: kind === value ? "var(--on-cta)" : "var(--muted)",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <p className="text-muted mt-3 text-xs leading-relaxed">
        {kind === "jd" ? (
          <>
            The posting is better evidence than anything we could tell you about{" "}
            {company} — they wrote it, and it is about the actual role.
          </>
        ) : (
          <>
            Anything you have heard: what someone who works there told you, a review
            you read, what a friend was asked at interview. We will read the skills out
            of it and label it <b>from you</b> — we are not treating it as something we
            checked, and we will not add anything to your resume from it.
          </>
        )}
      </p>

      <label htmlFor="evidence-text" className="sr-only">
        {kind === "jd" ? "Their job posting" : "What you know about them"}
      </label>
      <textarea
        id="evidence-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        placeholder={
          kind === "jd"
            ? "Paste the full job posting here…"
            : `e.g. a friend there said the team is mostly Java and Kafka, and they ask about system design…`
        }
        className="field mt-3 w-full font-mono text-sm"
      />

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          onClick={() =>
            onTarget(
              kind === "jd"
                ? { jd: text }
                : { notes: text, companyName: company },
            )
          }
          disabled={busy !== null || rebuilding || short || disabled}
          className="btn btn-primary text-sm"
        >
          {rebuilding
            ? "Working…"
            : disabled
              ? "No targets left on this resume"
              : `Tailor for ${company}`}
        </button>
        <span className="text-muted text-xs">
          {short
            ? `At least ${min} characters.`
            : `${text.trim().length.toLocaleString()} characters`}
        </span>
      </div>
    </div>
  );
}

/**
 * The single most convincing screen in the product: your resume, as text, the
 * way a parser sees it. People upload a beautifully designed two-column PDF and
 * find their job titles interleaved with their skills.
 */
function RawTab({ resume }: { resume: ResumeView }) {
  return (
    <div>
      <h2 className="font-display text-2xl font-semibold">What the machine reads</h2>
      <p className="text-muted mt-2 max-w-2xl leading-relaxed">
        This is the text an applicant tracking system extracts from your file — not what
        you see, what it sees. If your sections run into each other here, they run into
        each other for the recruiter searching too.
      </p>
      {resume.report?.findings?.length ? (
        <div className="mt-6">
          <Findings findings={resume.report.findings} />
          <p className="text-muted mt-4 text-sm">
            <Link href={`/app/${resume.id}/edit`} className="text-brand underline">
              Fix these in the editor
            </Link>{" "}
            — the same fields the PDF is printed from, scored on the same ruler when
            you rebuild.
          </p>
        </div>
      ) : null}
      <pre className="bg-surface-2 border-border mt-6 max-h-[32rem] overflow-auto rounded-xl border p-5 font-mono text-xs leading-relaxed whitespace-pre-wrap">
        {resume.text || "Nothing could be extracted from this file."}
      </pre>
    </div>
  );
}

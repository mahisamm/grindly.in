"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type {
  Advice, CompanyPack, CompanyResearch, Fidelity, Report,
} from "@/lib/reportTypes";
import { SHIPPABLE_FLOOR } from "@/lib/reportTypes";
import { isUnlimited } from "@/lib/plans";
import { FidelityLine, Findings, ReportPanel, ScoreDial } from "@/components/Score";

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
  text: string;
  report: Report | null;
  advice: Advice | null;
  skills: string[];
  variants: VariantView[];
  targets: TargetView[];
};

type Tab = "report" | "rewrite" | "target" | "raw";

export function ResumeWorkspace({
  resume,
  packs,
  disclaimer,
  targetLimit,
}: {
  resume: ResumeView;
  packs: CompanyPack[];
  disclaimer: string;
  /** Company targets this plan allows per resume. */
  targetLimit: number;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("report");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

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
        setError(data?.error ?? "That did not work.");
        return null;
      }
      if (data?.message) setNote(data.message);
      router.refresh();
      return data;
    } catch {
      setError("We could not reach the server.");
      return null;
    } finally {
      setBusy(null);
    }
  }

  const tabs: [Tab, string][] = [
    ["report", "Readiness"],
    ["rewrite", `Rewrites${resume.variants.length ? ` (${resume.variants.length})` : ""}`],
    ["target", `Target a company${resume.targets.length ? ` (${resume.targets.length})` : ""}`],
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
          <DeleteResume id={resume.id} label={resume.label} />
        </div>
      </div>

      {/* A strip that scrolls sideways below `sm`, and wraps above it.
          Four tabs do not fit across 390px: they wrapped onto three ragged
          lines with the selected underline stranded on the first, and the row
          stopped reading as one control at all. */}
      <div className="tab-strip border-border mt-6 border-b" role="tablist">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            id={`tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`panel-${key}`}
            // Only the selected tab is in the tab order, and arrow keys move
            // between them — the ARIA tabs pattern. Without it a screen reader
            // announces "tab 1 of 4" with no panel attached, and a keyboard user
            // has to Tab through all four to reach the content.
            tabIndex={tab === key ? 0 : -1}
            onKeyDown={(e) => {
              const i = tabs.findIndex(([k]) => k === tab);
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                const next = (i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
                setTab(tabs[next][0]);
                document.getElementById(`tab-${tabs[next][0]}`)?.focus();
              }
            }}
            onClick={() => setTab(key)}
            className="-mb-px cursor-pointer border-b-2 px-3.5 py-2.5 text-sm font-medium whitespace-nowrap transition-colors sm:px-4"
            style={{
              borderColor: tab === key ? "var(--brand)" : "transparent",
              color: tab === key ? "var(--ink-color)" : "var(--muted)",
            }}
          >
            {label}
          </button>
        ))}
      </div>

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

      {/* All four panels exist; the inactive ones are `hidden`.
          Rendering only the selected panel left three of the four `aria-controls`
          on the tab row pointing at element ids that were not in the document.
          A screen reader announces those as tabs that control nothing, and the
          relationship the whole ARIA tabs pattern is built on is simply absent
          for three quarters of the row. `hidden` keeps them out of the
          accessibility tree and out of the tab order while keeping the id
          reachable. */}
      <div className="py-8" role="tabpanel" id="panel-report" aria-labelledby="tab-report" hidden={tab !== "report"}>
        <ReportTab
          resume={resume}
          busy={busy}
          onAdvice={() => post(`/api/resumes/${resume.id}/advice`, undefined, "advice")}
        />
      </div>
      <div className="py-8" role="tabpanel" id="panel-rewrite" aria-labelledby="tab-rewrite" hidden={tab !== "rewrite"}>
        <RewriteTab
          resume={resume}
          busy={busy}
          onRun={(targetId) =>
            post(`/api/resumes/${resume.id}/variants`, targetId ? { targetId } : {}, "rewrite")
          }
        />
      </div>
      <div className="py-8" role="tabpanel" id="panel-target" aria-labelledby="tab-target" hidden={tab !== "target"}>
        <TargetTab
          resume={resume}
          packs={packs}
          disclaimer={disclaimer}
          targetLimit={targetLimit}
          busy={busy}
          onTarget={(body) => post(`/api/resumes/${resume.id}/variants`, body, "rewrite")}
        />
      </div>
      <div className="py-8" role="tabpanel" id="panel-raw" aria-labelledby="tab-raw" hidden={tab !== "raw"}>
        <RawTab resume={resume} />
      </div>
    </div>
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
        style={{ background: "#a3271b", color: "var(--paper)" }}
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

function ReportTab({
  resume,
  busy,
  onAdvice,
}: {
  resume: ResumeView;
  busy: string | null;
  onAdvice: () => void;
}) {
  if (!resume.report) {
    return (
      <p className="text-muted text-sm">
        We stored this file but could not read a report from it. Try uploading the
        original PDF rather than a scan or a screenshot.
      </p>
    );
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr]">
      <div>
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
        <ReportPanel report={resume.report} />
      </div>
      <aside>
        <div className="bg-surface border-border rounded-xl border p-5">
          <h3 className="font-display text-lg font-semibold">A recruiter&rsquo;s read</h3>
          <p className="text-muted mt-1.5 text-sm leading-snug">
            The score above is arithmetic. This is a model&rsquo;s opinion on the writing —
            it never produces a number and it can never suggest a fact you did not
            already claim.
          </p>
          {resume.advice ? (
            <div className="mt-4 flex flex-col gap-4 text-sm">
              <AdviceList title="Working" items={resume.advice.strengths} />
              <AdviceList title="Weak" items={resume.advice.issues} />
              <AdviceList title="Do this" items={resume.advice.suggestions} />
            </div>
          ) : (
            // Capped, not full-bleed: in the one-column layout below `lg` this
            // aside spans the whole page, and a button stretched across 700px
            // of tablet reads as a banner rather than a control.
            <button
              onClick={onAdvice}
              disabled={busy !== null}
              className="btn mt-4 w-full justify-center sm:w-auto sm:min-w-52"
            >
              {busy === "advice" ? "Reading…" : "Ask for a review"}
            </button>
          )}
        </div>

        {resume.skills.length > 0 && (
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
        )}
      </aside>
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
  onRun,
}: {
  resume: ResumeView;
  busy: string | null;
  onRun: (targetId: string | null) => void;
}) {
  const untargeted = resume.variants.filter((v) => !v.targetId);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h2 className="font-display text-2xl font-semibold">Three rebuilds, measured</h2>
          <p className="text-muted mt-2 leading-relaxed">
            Each one is rendered to a real PDF, read back with the extractor a parser uses,
            and scored on the same ruler as your original. Anything that scores{" "}
            <i>below</i> your resume is discarded; anything level with it is kept and
            labelled, because the same score on a clean single-column layout is still a
            win for a parser.
          </p>
          <p className="text-muted mt-2 leading-relaxed">
            We aim for {SHIPPABLE_FLOOR} and above. Everything mechanical — clean
            extraction, contact fields a parser can lift, standard headings, one column —
            is ours to get right, and a rebuild that still lands short says which one
            thing is missing rather than quietly handing you a weaker document. The part
            we will never do to reach the number is write a fact you did not.
          </p>
        </div>
        <button onClick={() => onRun(null)} disabled={busy !== null} className="btn btn-primary">
          {busy === "rewrite" ? "Rebuilding…" : untargeted.length ? "Run again" : "Rebuild my resume"}
        </button>
      </div>

      {busy === "rewrite" && (
        <p className="text-muted mt-6 text-sm">
          This takes a minute or two — several rewrites, each rendered and re-measured.
        </p>
      )}

      {untargeted.length === 0 ? (
        <p className="text-muted mt-8 text-sm">No rewrites yet.</p>
      ) : (
        <ul className="mt-8 grid gap-5 lg:grid-cols-3">
          {untargeted.map((v) => (
            <VariantCard key={v.id} variant={v} />
          ))}
        </ul>
      )}
    </div>
  );
}

function VariantCard({ variant }: { variant: VariantView }) {
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
        <ScoreDial score={variant.score} grade={variant.grade} size={64} />
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

      <div className="mt-auto flex gap-2 pt-5">
        <a
          href={`/api/variants/${variant.id}/file`}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-primary flex-1 justify-center text-sm"
        >
          Open PDF
        </a>
      </div>
    </li>
  );
}

function TargetTab({
  resume,
  packs,
  disclaimer,
  targetLimit,
  busy,
  onTarget,
}: {
  resume: ResumeView;
  packs: CompanyPack[];
  disclaimer: string;
  targetLimit: number;
  busy: string | null;
  onTarget: (body: Record<string, string>) => void;
}) {
  const [jd, setJd] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  // Said up front rather than discovered by hitting a 402. Aiming at a company
  // the resume is already aimed at reuses that target and costs nothing more,
  // so the count is of NEW targets left, not of clicks left.
  const unlimited = isUnlimited(targetLimit);
  const used = resume.targets.length;
  const left = Math.max(0, targetLimit - used);

  return (
    <div className="flex flex-col gap-10">
      <section>
        <h2 className="font-display text-2xl font-semibold">Aim it at a company</h2>
        <p className="text-muted mt-2 max-w-2xl leading-relaxed">
          Each pack is what the employer has published about how it hires, with the link so
          you can check. Targeting changes what your resume <i>surfaces</i> — it can never
          add a skill, a date or a number you did not already have.
        </p>
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

        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {packs.map((p) => {
            const existing = resume.targets.find((t) => t.slug === p.slug);
            const variants = existing
              ? resume.variants.filter((v) => v.targetId === existing.id)
              : [];
            return (
              // flex-col with the action pushed to the bottom: the summaries
              // are two to four lines long, so without it every button in a row
              // sits at a different height and the grid reads as broken.
              <li key={p.slug} className="bg-surface border-border flex flex-col rounded-xl border p-5">
                <h3 className="font-display text-lg font-semibold">{p.name}</h3>
                <p className="text-muted mt-1.5 text-sm leading-snug">{p.summary}</p>

                <button
                  onClick={() => setOpen(open === p.slug ? null : p.slug)}
                  className="text-muted hover:text-ink mt-3 text-xs underline"
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
                    disabled={busy !== null || (!existing && left === 0)}
                    title={!existing && left === 0 ? "No targets left on this resume" : undefined}
                    className="btn w-full justify-center text-sm"
                  >
                    {busy === "rewrite"
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

      <AnyCompany resume={resume} busy={busy} onTarget={onTarget} targetsLeft={left} />

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
            disabled={busy !== null || jd.trim().length < 60}
            className="btn btn-primary"
          >
            {busy === "rewrite" ? "Working…" : "Tailor to this role"}
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
                      <VariantCard key={v.id} variant={v} />
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
      </section>
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
  onTarget,
  targetsLeft,
}: {
  resume: ResumeView;
  busy: string | null;
  onTarget: (body: Record<string, string>) => void;
  /** New company targets this plan still allows on this resume. */
  targetsLeft: number;
}) {
  const [name, setName] = useState("");
  const [looking, setLooking] = useState(false);
  const [found, setFound] = useState<CompanyResearch | null>(null);
  const [error, setError] = useState<string | null>(null);

  const existing = found
    ? resume.targets.find((t) => t.name.toLowerCase() === found.name.toLowerCase())
    : undefined;

  async function look() {
    const typed = name.trim();
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
    <section className="border-border border-t pt-10">
      <h2 className="font-display text-2xl font-semibold">Any other company</h2>
      <p className="text-muted mt-2 max-w-2xl leading-relaxed">
        Type a name — the packs above are the ones a person has read the sources
        for, not the only companies you can aim at. We will tell you what we actually
        know about how they screen, and when the honest answer is &ldquo;nothing
        specific&rdquo;, you will get that instead of a paragraph we made up.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          look();
        }}
        className="mt-5 flex flex-wrap gap-3"
      >
        <label className="min-w-[16rem] flex-1">
          <span className="sr-only">Company name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            placeholder="Freshworks, Zoho, a 40-person startup…"
            className="field w-full"
          />
        </label>
        <button
          type="submit"
          disabled={looking || name.trim().length < 2}
          className="btn"
        >
          {looking ? "Looking…" : "Look it up"}
        </button>
      </form>

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
                disabled={busy !== null || (!existing && targetsLeft === 0)}
                className="btn btn-primary mt-5"
              >
                {busy === "rewrite"
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
    </section>
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
  disabled,
  onTarget,
}: {
  company: string;
  busy: string | null;
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
              background: kind === value ? "var(--vermilion)" : "transparent",
              color: kind === value ? "var(--paper)" : "var(--muted)",
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
          disabled={busy !== null || short || disabled}
          className="btn btn-primary text-sm"
        >
          {busy === "rewrite"
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
        </div>
      ) : null}
      <pre className="bg-surface-2 border-border mt-6 max-h-[32rem] overflow-auto rounded-xl border p-5 font-mono text-xs leading-relaxed whitespace-pre-wrap">
        {resume.text || "Nothing could be extracted from this file."}
      </pre>
    </div>
  );
}

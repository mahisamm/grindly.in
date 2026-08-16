"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Advice, CompanyPack, Fidelity, Report } from "@/lib/reportTypes";
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
  spec: { skills?: string[]; must_have?: string[]; nice_to_have?: string[] } | null;
};

type ResumeView = {
  id: string;
  label: string;
  chars: number;
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
}: {
  resume: ResumeView;
  packs: CompanyPack[];
  disclaimer: string;
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
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-display text-3xl font-bold">{resume.label}</h1>
        <div className="flex items-center gap-4">
          {resume.report && (
            <span className="text-muted font-mono text-[11px] tracking-[0.1em] uppercase">
              {resume.chars.toLocaleString()} characters read
            </span>
          )}
          <DeleteResume id={resume.id} label={resume.label} />
        </div>
      </div>

      <div className="border-border mt-6 flex flex-wrap gap-1 border-b" role="tablist">
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
            className="-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors"
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

      <div className="py-8" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "report" && (
          <ReportTab resume={resume} busy={busy} onAdvice={() => post(`/api/resumes/${resume.id}/advice`, undefined, "advice")} />
        )}
        {tab === "rewrite" && (
          <RewriteTab
            resume={resume}
            busy={busy}
            onRun={(targetId) =>
              post(`/api/resumes/${resume.id}/variants`, targetId ? { targetId } : {}, "rewrite")
            }
          />
        )}
        {tab === "target" && (
          <TargetTab
            resume={resume}
            packs={packs}
            disclaimer={disclaimer}
            busy={busy}
            onTarget={(body) => post(`/api/resumes/${resume.id}/variants`, body, "rewrite")}
          />
        )}
        {tab === "raw" && <RawTab resume={resume} />}
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
            <button onClick={onAdvice} disabled={busy !== null} className="btn mt-4 w-full justify-center">
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
  busy,
  onTarget,
}: {
  resume: ResumeView;
  packs: CompanyPack[];
  disclaimer: string;
  busy: string | null;
  onTarget: (body: Record<string, string>) => void;
}) {
  const [jd, setJd] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-10">
      <section>
        <h2 className="font-display text-2xl font-semibold">Aim it at a company</h2>
        <p className="text-muted mt-2 max-w-2xl leading-relaxed">
          Each pack is what the employer has published about how it hires, with the link so
          you can check. Targeting changes what your resume <i>surfaces</i> — it can never
          add a skill, a date or a number you did not already have.
        </p>

        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {packs.map((p) => {
            const existing = resume.targets.find((t) => t.slug === p.slug);
            const variants = existing
              ? resume.variants.filter((v) => v.targetId === existing.id)
              : [];
            return (
              <li key={p.slug} className="bg-surface border-border rounded-xl border p-5">
                <h3 className="font-display text-lg font-semibold">{p.name}</h3>
                <p className="text-muted mt-1.5 text-sm leading-snug">{p.summary}</p>

                <button
                  onClick={() => setOpen(open === p.slug ? null : p.slug)}
                  className="text-muted hover:text-ink mt-3 text-xs underline"
                >
                  {open === p.slug ? "Hide sources" : `${p.sources.length} sources`}
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

                <button
                  onClick={() =>
                    onTarget(existing ? { targetId: existing.id } : { company: p.slug })
                  }
                  disabled={busy !== null}
                  className="btn mt-4 w-full justify-center text-sm"
                >
                  {busy === "rewrite" ? "Working…" : variants.length ? "Rebuild" : "Tailor for " + p.name}
                </button>
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
        <textarea
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
          .filter((t) => t.kind === "jd")
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
                <h3 className="font-display text-lg font-semibold">{t.name}</h3>
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

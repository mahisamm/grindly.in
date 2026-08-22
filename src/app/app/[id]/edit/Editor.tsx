"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Report } from "@/lib/reportTypes";
import { SHIPPABLE_FLOOR } from "@/lib/reportTypes";
import type { ResumeStruct } from "@/lib/resumeStruct";
import { LIMITS } from "@/lib/resumeStruct";
import { ScoreDial } from "@/components/Score";

/**
 * The resume, as fields you can change.
 *
 * This is the half of the product that was missing. Grindly could tell you,
 * precisely and repeatably, that a bullet has no outcome in it and that a
 * parser cannot find your dates — and then it handed you a PDF and stopped.
 * Acting on any of it meant going back to Word, guessing, re-exporting and
 * re-uploading, and the ruler that told you the problem could not tell you
 * whether you had fixed it until you had done all of that.
 *
 * Two deliberate absences:
 *
 *   No rich text. The renderer prints one family at one weight because that is
 *   what survives extraction (see the invariants in render_pdf.py). A bold
 *   button would offer control over something the output does not have.
 *
 *   No anti-fabrication gates. Those exist because a MODEL must not introduce a
 *   fact the user did not claim. A person typing about themselves is the only
 *   source this product has ever accepted, and the gates would be telling them
 *   they are not allowed to mention a job they had.
 */

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * The sections people actually come here to add, as one-tap presets.
 *
 * Beta feedback: "I want to add my projects and I cannot find where." The
 * only control was "Add a section" at the very bottom of a long page, which
 * produced a blank card with a blank heading — two decisions before anyone
 * could type a project name. A preset names the section and opens its first
 * entry; if the section already exists, the tap jumps to it instead of
 * making a twin.
 */
const SECTION_PRESETS: { heading: string; label: string }[] = [
  { heading: "Projects", label: "Projects" },
  { heading: "Experience", label: "Experience" },
  { heading: "Education", label: "Education" },
  { heading: "Technical Skills", label: "Skills" },
  { heading: "Certifications", label: "Certifications" },
  { heading: "Achievements", label: "Achievements" },
  { heading: "Professional Summary", label: "Summary" },
];

/** What kind of thing an entry in this section is, for labels and hints. */
function sectionKind(heading: string): "project" | "job" | "study" | "other" {
  const h = heading.toLowerCase();
  if (/project|portfolio|open[- ]source/.test(h)) return "project";
  if (/experience|work|employment|internship|career/.test(h)) return "job";
  if (/education|academic|qualification|school|university|college/.test(h)) return "study";
  return "other";
}

const ENTRY_COPY = {
  project: {
    add: "Add a project",
    title: "Project name",
    titleHint: "e.g. Campus placement tracker",
    sub: "Tech used, and dates",
    subHint: "React, FastAPI, PostgreSQL · Jan 2026 – Mar 2026",
  },
  job: {
    add: "Add a job",
    title: "Job title",
    titleHint: "e.g. Software Engineer",
    sub: "Company, dates, location",
    subHint: "Acme Data Systems · 2024 – Present · Hyderabad",
  },
  study: {
    add: "Add a qualification",
    title: "Degree or course",
    titleHint: "e.g. B.Tech in Computer Science",
    sub: "Institution, dates, grade",
    subHint: "JNTU Hyderabad · 2019 – 2023 · CGPA 8.1",
  },
  other: {
    add: "Add an entry",
    title: "Title",
    titleHint: "",
    sub: "Organisation and dates",
    subHint: "",
  },
} as const;

export function Editor({
  resumeId,
  resumeLabel,
  initial,
  baselineScore,
}: {
  resumeId: string;
  resumeLabel: string;
  initial: ResumeStruct;
  /** What the resume scored before any of this — the number to beat. */
  baselineScore: number | null;
}) {
  const router = useRouter();
  const [struct, setStruct] = useState<ResumeStruct>(initial);
  const [save, setSave] = useState<SaveState>("idle");
  const [building, setBuilding] = useState(false);
  const [built, setBuilt] = useState<{ score: number; grade: string; report: Report | null } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  // The section to bring into view after an add — set in the click handler,
  // consumed by the effect below, so adding "Projects" from the toolbar lands
  // the user on the new card instead of leaving it somewhere below the fold.
  const [focusSection, setFocusSection] = useState<number | null>(null);
  const sectionRefs = useRef<(HTMLElement | null)[]>([]);
  useEffect(() => {
    if (focusSection === null) return;
    const el = sectionRefs.current[focusSection];
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    el?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
  }, [focusSection, struct.sections.length]);

  // What was last written to the server, so an autosave that would be a no-op
  // does not fire. Compared as JSON because the structure is a plain tree and
  // that is exactly what it is: a value.
  const savedRef = useRef(JSON.stringify(initial));
  // The latest draft, for the unload handler — which fires outside React and
  // therefore cannot read state. Written from an effect rather than during
  // render: a ref mutated while rendering is a side effect in the render pass,
  // and React is entitled to render twice.
  const structRef = useRef(struct);
  useEffect(() => {
    structRef.current = struct;
  }, [struct]);

  // Takes the draft rather than reading a ref: a save should write the value
  // its caller meant, not whatever happens to be current when the request is
  // built.
  const persist = useCallback(
    async (draft: ResumeStruct): Promise<boolean> => {
    const body = JSON.stringify(draft);
    if (body === savedRef.current) return true;
    setSave("saving");
    try {
      const res = await fetch(`/api/resumes/${resumeId}/struct`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ struct: draft }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? "Could not save your changes.");
        setSave("error");
        return false;
      }
      savedRef.current = body;
      setSave("saved");
      setError(null);
      return true;
    } catch {
      setError("We could not reach the server. Your changes are still on this page.");
      setSave("error");
      return false;
    }
    },
    [resumeId],
  );

  // Autosave, debounced. Deliberately not on every keystroke: this is a PUT
  // that rewrites a jsonb column, and typing a bullet would otherwise be forty
  // of them.
  useEffect(() => {
    const timer = setTimeout(() => void persist(struct), 1200);
    return () => clearTimeout(timer);
  }, [struct, persist]);

  // The one case autosave cannot cover. A debounce that has not fired when the
  // tab closes loses whatever was typed in the last second — which is the most
  // recent thing they wrote, and the thing they will most notice missing.
  useEffect(() => {
    const onLeave = () => {
      if (JSON.stringify(structRef.current) === savedRef.current) return;
      // keepalive, because a normal fetch is cancelled as the page unloads.
      // POST rather than PUT: a beacon can only ever be a POST. The struct
      // route accepts both and handles them identically.
      navigator.sendBeacon?.(
        `/api/resumes/${resumeId}/struct`,
        new Blob([JSON.stringify({ struct: structRef.current })], { type: "application/json" }),
      );
    };
    window.addEventListener("pagehide", onLeave);
    return () => window.removeEventListener("pagehide", onLeave);
  }, [resumeId]);

  async function build() {
    setBuilding(true);
    setError(null);
    setBuilt(null);
    const ok = await persist(struct);
    if (!ok) {
      setBuilding(false);
      return;
    }
    try {
      const res = await fetch(`/api/resumes/${resumeId}/build`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "Could not build the document.");
        return;
      }
      setBuilt({ score: data.score, grade: data.grade, report: data.report ?? null });
      router.refresh();
    } catch {
      setError("We could not reach the server.");
    } finally {
      setBuilding(false);
    }
  }

  // Every mutation replaces the whole tree. The document is small — tens of
  // fields — and a reducer with twelve action types would be more machinery
  // than the problem has.
  const edit = (fn: (draft: ResumeStruct) => void) => {
    setStruct((current) => {
      const next: ResumeStruct = JSON.parse(JSON.stringify(current));
      fn(next);
      return next;
    });
  };

  const delta = built && baselineScore !== null ? built.score - baselineScore : null;

  return (
    <div className="grid gap-8 lg:grid-cols-[1.6fr_1fr]">
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="font-display text-2xl font-bold sm:text-3xl">Edit {resumeLabel}</h1>
          <p className="text-muted font-mono text-[11px] tracking-[0.1em] uppercase" role="status">
            {save === "saving"
              ? "Saving…"
              : save === "saved"
                ? "Saved"
                : save === "error"
                  ? "Not saved"
                  : ""}
          </p>
        </div>

        <p className="text-muted mt-2 max-w-2xl leading-relaxed">
          These are the fields the PDF is printed from — the same structure every rebuild
          works on. Change what you like; nothing here is checked against your original,
          because it is your resume and you are the source.
        </p>

        {/* The front door for "I want to add my projects": one tap names the
            section, opens its first entry and scrolls there. Existing sections
            are jumped to, not duplicated. The generic "Add a section" survives
            at the bottom for anything without a preset. */}
        <div className="bg-surface border-border mt-6 rounded-xl border p-4">
          <p className="font-mono text-[10px] tracking-[0.14em] uppercase opacity-60">
            Add to your resume
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {SECTION_PRESETS.map((preset) => {
              const existing = struct.sections.findIndex(
                (sec) => sec.heading.trim().toLowerCase() === preset.heading.toLowerCase(),
              );
              return (
                <button
                  key={preset.heading}
                  type="button"
                  onClick={() => {
                    if (existing >= 0) {
                      setFocusSection(existing);
                      return;
                    }
                    if (struct.sections.length >= LIMITS.sections) return;
                    edit((d) =>
                      void d.sections.push({
                        heading: preset.heading,
                        items: [{ head: "", sub: "", bullets: [""] }],
                      }),
                    );
                    setFocusSection(struct.sections.length);
                  }}
                  className="cursor-pointer rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors"
                  style={
                    existing >= 0
                      ? { borderColor: "var(--line-2)", color: "var(--muted)" }
                      : { borderColor: "var(--cta)", color: "var(--brand)" }
                  }
                  title={existing >= 0 ? `Jump to ${preset.heading}` : `Add a ${preset.label} section`}
                >
                  {existing >= 0 ? preset.label : `+ ${preset.label}`}
                </button>
              );
            })}
          </div>
          <p className="text-muted mt-2 text-xs">
            Faded ones already exist — tap to jump there. Anything else: &ldquo;Add a
            section&rdquo; at the bottom.
          </p>
        </div>

        {error && (
          <p
            role="alert"
            className="mt-5 rounded-lg border p-3 text-sm"
            style={{ borderColor: "#a3271b", color: "#a3271b" }}
          >
            {error}
          </p>
        )}

        <div className="bg-surface border-border mt-6 rounded-xl border p-5">
          <Field
            label="Name"
            value={struct.name}
            maxLength={LIMITS.nameChars}
            onChange={(v) => edit((d) => void (d.name = v))}
          />
          <div className="mt-4">
            <Field
              label="Contact line"
              value={struct.contact_line}
              maxLength={LIMITS.contactChars}
              hint="Email, phone, city, links — one line, separated however you like. A parser reads each field separately, so keep them whole."
              onChange={(v) => edit((d) => void (d.contact_line = v))}
            />
          </div>
        </div>

        {struct.sections.map((section, si) => {
          const copy = ENTRY_COPY[sectionKind(section.heading)];
          return (
          <section
            key={si}
            ref={(el) => {
              sectionRefs.current[si] = el;
            }}
            className="bg-surface border-border mt-5 scroll-mt-6 rounded-xl border p-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <input
                value={section.heading}
                maxLength={LIMITS.headChars}
                aria-label={`Section ${si + 1} heading`}
                onChange={(e) => edit((d) => void (d.sections[si].heading = e.target.value))}
                className="field font-display flex-1 text-lg font-semibold"
                placeholder="Experience"
              />
              <button
                onClick={() => edit((d) => void d.sections.splice(si, 1))}
                className="text-muted hover:text-ink cursor-pointer text-xs underline"
              >
                Remove section
              </button>
            </div>

            {section.items.map((item, ii) => (
              <div key={ii} className="border-border mt-4 border-t pt-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    label={copy.title}
                    value={item.head}
                    maxLength={LIMITS.headChars}
                    placeholder={copy.titleHint}
                    onChange={(v) => edit((d) => void (d.sections[si].items[ii].head = v))}
                  />
                  <Field
                    label={copy.sub}
                    value={item.sub}
                    maxLength={LIMITS.headChars}
                    placeholder={copy.subHint}
                    hint="Keep dates on this line. Right-aligning them is what a good-looking resume does and what breaks extraction."
                    onChange={(v) => edit((d) => void (d.sections[si].items[ii].sub = v))}
                  />
                </div>

                <ul className="mt-3 flex flex-col gap-2">
                  {item.bullets.map((bullet, bi) => (
                    <li key={bi} className="flex items-start gap-2">
                      <span className="text-muted mt-2.5 select-none">•</span>
                      <textarea
                        value={bullet}
                        rows={2}
                        maxLength={LIMITS.bulletChars}
                        aria-label={`Bullet ${bi + 1}`}
                        onChange={(e) =>
                          edit((d) => void (d.sections[si].items[ii].bullets[bi] = e.target.value))
                        }
                        className="field flex-1 text-sm"
                        placeholder="Led an action, and what came of it."
                      />
                      <button
                        onClick={() => edit((d) => void d.sections[si].items[ii].bullets.splice(bi, 1))}
                        aria-label={`Remove bullet ${bi + 1}`}
                        className="text-muted hover:text-ink mt-2 cursor-pointer text-xs"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>

                <div className="mt-3 flex flex-wrap gap-4 text-xs">
                  <button
                    onClick={() => edit((d) => void d.sections[si].items[ii].bullets.push(""))}
                    disabled={item.bullets.length >= LIMITS.bulletsPerItem}
                    className="text-brand cursor-pointer underline"
                  >
                    Add a bullet
                  </button>
                  <button
                    onClick={() => edit((d) => void d.sections[si].items.splice(ii, 1))}
                    className="text-muted hover:text-ink cursor-pointer underline"
                  >
                    Remove this entry
                  </button>
                </div>
              </div>
            ))}

            <button
              onClick={() =>
                edit((d) => void d.sections[si].items.push({ head: "", sub: "", bullets: [""] }))
              }
              disabled={section.items.length >= LIMITS.itemsPerSection}
              className="btn mt-4 text-sm"
            >
              {copy.add}
            </button>
          </section>
          );
        })}

        <button
          onClick={() => {
            edit((d) =>
              void d.sections.push({ heading: "", items: [{ head: "", sub: "", bullets: [""] }] }),
            );
            setFocusSection(struct.sections.length);
          }}
          disabled={struct.sections.length >= LIMITS.sections}
          className="btn mt-5"
        >
          Add a section
        </button>
      </div>

      {/* The measurement, kept beside the fields rather than on another page.
          The whole point of editing here is that the ruler is in view while you
          change the thing it measures. */}
      <aside className="lg:sticky lg:top-6 lg:self-start">
        <div className="bg-surface border-border rounded-xl border p-5">
          <h2 className="font-display text-lg font-semibold">Build and measure</h2>
          <p className="text-muted mt-1.5 text-sm leading-snug">
            Renders these fields to a real PDF, reads it back with the extractor a parser
            uses, and scores it on the same ruler as your original.
          </p>

          <button
            onClick={build}
            disabled={building}
            className="btn btn-primary mt-4 w-full justify-center"
          >
            {building ? "Building…" : "Build and score it"}
          </button>

          {built && (
            <div className="border-border mt-5 border-t pt-5">
              <div className="flex items-center gap-4">
                <ScoreDial score={built.score} grade={built.grade} size={72} />
                <div>
                  <p className="font-medium">
                    {delta === null
                      ? `Scored ${built.score}`
                      : delta > 0
                        ? `+${delta} on your original`
                        : delta === 0
                          ? "Level with your original"
                          : `${delta} against your original`}
                  </p>
                  <p className="text-muted mt-0.5 text-xs">
                    {built.score >= SHIPPABLE_FLOOR
                      ? `At or above ${SHIPPABLE_FLOOR} — this is a document worth sending.`
                      : `Under ${SHIPPABLE_FLOOR}. What is missing is content, not layout.`}
                  </p>
                </div>
              </div>

              {built.report?.findings?.length ? (
                <ul className="mt-4 flex flex-col gap-2 text-sm">
                  {built.report.findings.slice(0, 4).map((f, i) => (
                    <li key={i} className="leading-snug">
                      <span
                        className="font-mono text-[10px] tracking-[0.1em] uppercase"
                        style={{ color: f.severity === "critical" ? "#a3271b" : "var(--warn)" }}
                      >
                        {f.severity}
                      </span>
                      <br />
                      {f.fix || f.problem}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-4 text-sm">Nothing mechanical left to fix.</p>
              )}

              <Link href={`/app/${resumeId}?tab=rewrite`} className="btn mt-5 w-full justify-center text-sm">
                See it beside the rebuilds
              </Link>
            </div>
          )}
        </div>

        <p className="text-muted mt-4 text-xs leading-relaxed">
          Saved as you type. Building it is the only step that costs anything against your
          daily limit — you can edit for as long as you like first.
        </p>

        {/* The other two formats, offered where the document is.
            A PDF is right for a person and wrong for a form: half the campus
            portals in India accept DOCX only, and every application has a box
            that wants the text. */}
        <div className="bg-surface border-border mt-4 rounded-xl border p-5">
          <h2 className="font-display text-base font-semibold">Other formats</h2>
          <p className="text-muted mt-1.5 text-xs leading-relaxed">
            Built from these same fields. A portal that accepts DOCX only, and a plain
            text version for the box on an application form — pasting out of a PDF is
            what produces the mangling this whole product measures.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a href={`/api/resumes/${resumeId}/export?format=docx`} className="btn text-sm">
              Download .docx
            </a>
            <a href={`/api/resumes/${resumeId}/export?format=txt`} className="btn text-sm">
              Download .txt
            </a>
          </div>
        </div>
      </aside>
    </div>
  );
}

function Field({
  label,
  value,
  hint,
  placeholder,
  maxLength,
  onChange,
}: {
  label: string;
  value: string;
  hint?: string;
  /** An example value, greyed inside the box — what a good answer looks like
      for THIS kind of section, so a blank project card is not a blank page. */
  placeholder?: string;
  maxLength: number;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      <input
        value={value}
        maxLength={maxLength}
        placeholder={placeholder || undefined}
        onChange={(e) => onChange(e.target.value)}
        className="field w-full"
      />
      {hint && <span className="text-muted mt-1 block text-xs leading-snug">{hint}</span>}
    </label>
  );
}

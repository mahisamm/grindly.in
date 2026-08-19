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

        {struct.sections.map((section, si) => (
          <section key={si} className="bg-surface border-border mt-5 rounded-xl border p-5">
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
                    label="Title"
                    value={item.head}
                    maxLength={LIMITS.headChars}
                    onChange={(v) => edit((d) => void (d.sections[si].items[ii].head = v))}
                  />
                  <Field
                    label="Organisation and dates"
                    value={item.sub}
                    maxLength={LIMITS.headChars}
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
              Add an entry
            </button>
          </section>
        ))}

        <button
          onClick={() =>
            edit((d) =>
              void d.sections.push({ heading: "", items: [{ head: "", sub: "", bullets: [""] }] }),
            )
          }
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
                <ScoreDial score={built.score} grade={built.grade} size={64} />
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
      </aside>
    </div>
  );
}

function Field({
  label,
  value,
  hint,
  maxLength,
  onChange,
}: {
  label: string;
  value: string;
  hint?: string;
  maxLength: number;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      <input
        value={value}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        className="field w-full"
      />
      {hint && <span className="text-muted mt-1 block text-xs leading-snug">{hint}</span>}
    </label>
  );
}

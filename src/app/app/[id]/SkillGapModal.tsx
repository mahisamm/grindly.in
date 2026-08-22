"use client";

import { useEffect, useState } from "react";

/**
 * "These skills would raise your match — do you actually have them?"
 *
 * A targeted rebuild caps its ATS score on COVERAGE: the skills the role asks
 * for that the resume does not show. Some of those the candidate genuinely has
 * and simply never listed. This dialog is where they say which — one tick per
 * skill, nothing pre-ticked, because a skill is a claim and the product never
 * makes it for them. Approved skills are added to their own list and the
 * tailoring re-runs, lifting coverage honestly.
 *
 * Deliberately readable, not a cramped toast: it is asking the person to make a
 * claim they will have to defend in an interview, and that decision deserves
 * room and a plain warning.
 */
export function SkillGapModal({
  targetName,
  gaps,
  busy,
  rebuilding,
  onApprove,
  onClose,
}: {
  targetName: string;
  gaps: string[];
  /** True while the add-skills round trip is in flight — locks the inputs. */
  busy: boolean;
  /** A rebuild is already running elsewhere. The user can still TICK skills
      (prepare their choice), but cannot start the re-tailor until it frees —
      approving would collide with the in-flight batch. */
  rebuilding: boolean;
  onApprove: (skills: string[]) => void;
  onClose: () => void;
}) {
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    // Lock the page scroll while the dialog owns the screen.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [busy, onClose]);

  const selected = gaps.filter((g) => checked[g]);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
      style={{ background: "rgba(23,20,15,0.55)" }}
      onClick={() => !busy && onClose()}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="skillgap-title"
        onClick={(e) => e.stopPropagation()}
        className="bg-surface border-border animate-in max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border p-6 shadow-lg sm:p-7"
      >
        <h2 id="skillgap-title" className="font-display text-xl font-bold sm:text-2xl">
          Raise your match for {targetName || "this role"}
        </h2>
        <p className="text-muted mt-2 text-sm leading-relaxed">
          These skills {targetName || "the role"} looks for are not on your resume yet.
          Tick the ones you <b>genuinely have</b> — we will add them to your Technical
          Skills and re-tailor, which lifts your score. Leave anything you could not
          defend in an interview; we never claim a skill for you.
        </p>

        <fieldset className="mt-5">
          <legend className="sr-only">Skills you have</legend>
          <ul className="flex flex-col gap-1.5">
            {gaps.map((skill) => (
              <li key={skill}>
                <label className="hover:bg-surface-2 flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={Boolean(checked[skill])}
                    disabled={busy}
                    onChange={(e) =>
                      setChecked((c) => ({ ...c, [skill]: e.target.checked }))
                    }
                    className="size-4 shrink-0 cursor-pointer accent-[var(--cta)]"
                  />
                  <span className="text-sm">{skill}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>

        <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
          <button
            onClick={onClose}
            disabled={busy}
            className="text-muted hover:text-ink cursor-pointer text-sm underline"
          >
            My current skills are enough
          </button>
          <button
            onClick={() => onApprove(selected)}
            disabled={busy || rebuilding || selected.length === 0}
            className="btn btn-primary"
          >
            {busy
              ? "Adding & re-tailoring…"
              : rebuilding
                ? "A rebuild is running…"
                : selected.length === 0
                  ? "Tick the ones you have"
                  : `Add ${selected.length} & re-tailor`}
          </button>
        </div>
      </div>
    </div>
  );
}

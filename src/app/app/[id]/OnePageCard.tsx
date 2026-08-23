"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const STAGE_LABEL: Record<string, string> = {
  student: "a student",
  fresher: "a fresher",
  early: "early-career",
};

/**
 * "Want a one-page version?" — asked once, of the people it applies to.
 *
 * Shown only when the resume READS as student / fresher / early-career (read
 * off the document at upload — see readiness.career_stage) AND it runs two or
 * more pages. Campus and early-career hiring expects one page; a second page
 * of a two-year career reads as padding. An experienced person never sees
 * this card: two pages is right for them.
 *
 * The answer is a preference stored on the resume: yes puts a hard one-page
 * budget on every rebuild (plain and company-tailored) — same facts, fewer
 * words, measured on the real PDF; no keeps their length and never asks again.
 */
export function OnePageCard({
  resumeId,
  stage,
  signals,
  pages,
}: {
  resumeId: string;
  stage: string;
  signals: string[];
  pages: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<1 | 0 | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(targetPages: 1 | 0) {
    setBusy(targetPages);
    setError(null);
    try {
      const res = await fetch(`/api/resumes/${resumeId}/pages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetPages }),
      });
      if (!res.ok) {
        setError("Could not save that. Try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("We could not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  const who = STAGE_LABEL[stage] ?? "early-career";
  return (
    <div
      className="mb-6 rounded-2xl border p-5"
      style={{ borderColor: "var(--cta)", background: "var(--surface)" }}
      role="region"
      aria-label="One-page suggestion"
    >
      <p className="text-muted font-mono text-[10px] tracking-[0.12em] uppercase">A suggestion before you rebuild</p>
      <h3 className="font-display mt-1.5 text-lg font-semibold">
        This reads as {who} and runs {pages} pages — one page would serve you better.
      </h3>
      <p className="text-muted mt-2 text-sm leading-relaxed">
        Campus and early-career hiring expects a single page; a recruiter decides in the first
        screen, and a second page of a short career reads as padding. Say yes and every rebuild —
        plain or tailored for a company — gets a hard one-page budget: <b>every role, project,
        degree, date, number and skill stays</b>; we tighten the wording, merge bullets that say
        the same thing, and measure the real PDF. If it still will not fit, the card says so
        instead of cutting anything quietly. Your choice, and you can change it any time.
      </p>
      {signals.length > 0 && (
        <p className="text-muted mt-2 text-xs">
          Why we think so: {signals.join(" · ")}.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm" style={{ color: "#a3271b" }}>
          {error}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button onClick={() => choose(1)} disabled={busy !== null} className="btn btn-primary text-sm">
          {busy === 1 ? "Saving…" : "Yes — make my rebuilds one page"}
        </button>
        <button onClick={() => choose(0)} disabled={busy !== null} className="btn text-sm">
          {busy === 0 ? "Saving…" : "Keep my length"}
        </button>
      </div>
    </div>
  );
}

/** The small reminder on the Rewrite/Target tabs once a budget is on. */
export function PageBudgetChip({ resumeId, on }: { resumeId: string; on: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (!on) return null;
  async function turnOff() {
    setBusy(true);
    try {
      await fetch(`/api/resumes/${resumeId}/pages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetPages: 0 }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-[10px] tracking-[0.1em] uppercase"
      style={{ borderColor: "var(--cta)", color: "var(--brand)" }}
    >
      One-page budget on
      <button type="button" onClick={turnOff} disabled={busy} className="cursor-pointer underline underline-offset-2">
        {busy ? "…" : "turn off"}
      </button>
    </span>
  );
}

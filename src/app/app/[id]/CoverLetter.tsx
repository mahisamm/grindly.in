"use client";

import { useState } from "react";

/**
 * A cover letter, and the refusal that is part of the feature.
 *
 * Every other AI resume tool will write you a letter about your three years of
 * passion for the company's mission. This one checks the letter against your
 * resume first — technologies, figures, employers, and the length of experience
 * it claims — and when every draft fails, it says so and shows you which claim
 * broke. That refusal is not an error state to be minimised. It is the same
 * promise the rewrites make, applied to the format that invites lying hardest.
 *
 * Nothing is stored. A letter is written for one application and edited before
 * it is sent; keeping every draft would build a list of near-identical
 * paragraphs nobody scrolls.
 */
export function CoverLetter({
  resumeId,
  targets,
}: {
  resumeId: string;
  targets: { id: string; name: string }[];
}) {
  const [targetId, setTargetId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [letter, setLetter] = useState<{ text: string; used: string[]; company: string } | null>(
    null,
  );
  const [refusal, setRefusal] = useState<{ reason: string; problems: string[] } | null>(null);
  const [copied, setCopied] = useState(false);

  async function write() {
    setBusy(true);
    setLetter(null);
    setRefusal(null);
    setCopied(false);
    try {
      const res = await fetch(`/api/resumes/${resumeId}/cover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(targetId ? { targetId } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRefusal({
          reason: data?.error ?? "That did not work.",
          problems: Array.isArray(data?.problems) ? data.problems : [],
        });
        return;
      }
      setLetter({ text: data.letter, used: data.used ?? [], company: data.company ?? "" });
    } catch {
      setRefusal({ reason: "We could not reach the server.", problems: [] });
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!letter) return;
    try {
      await navigator.clipboard.writeText(letter.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      // Clipboard access can be refused outright. The text is on screen and
      // selectable, so this is a convenience failing rather than the feature.
    }
  }

  return (
    <section className="border-border border-t pt-10">
      <h2 className="font-display text-2xl font-semibold">A cover letter</h2>
      <p className="text-muted mt-2 max-w-2xl leading-relaxed">
        Written from what is on your resume and nothing else. Every draft is checked
        before you see it — a technology you have not listed, a figure that is not
        there, an employer you did not work for, or a claim about how many years you
        have, and it is thrown away rather than shown to you.
      </p>
      <p className="text-muted mt-2 max-w-2xl text-sm leading-relaxed">
        It will not tell them how much you admire their mission. We know nothing about
        that, and neither does anything that writes you one.
      </p>

      <div className="mt-5 flex flex-wrap items-end gap-3">
        {targets.length > 0 && (
          <label className="min-w-[14rem]">
            <span className="mb-1.5 block text-sm font-medium">Aim it at</span>
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              className="field w-full"
            >
              <option value="">No particular role</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button onClick={write} disabled={busy} className="btn btn-primary">
          {busy ? "Writing…" : "Write one"}
        </button>
      </div>

      {refusal && (
        <div
          role="status"
          className="mt-6 max-w-2xl rounded-lg border p-4"
          style={{ borderColor: "var(--warn)", background: "var(--surface-2)" }}
        >
          <p className="font-medium">No letter this time.</p>
          <p className="text-muted mt-1 text-sm leading-relaxed">{refusal.reason}</p>
          {refusal.problems.length > 0 && (
            <>
              <p className="mt-3 font-mono text-[10px] tracking-[0.12em] uppercase opacity-60">
                What the drafts claimed
              </p>
              <ul className="text-muted mt-1.5 list-disc space-y-1 pl-4 text-sm leading-snug">
                {refusal.problems.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
              <p className="text-muted mt-3 text-xs leading-relaxed">
                If any of these are true of you, they belong on your resume — add them in
                the editor and try again. If they are not, this is the tool working.
              </p>
            </>
          )}
        </div>
      )}

      {letter && (
        <div className="bg-surface border-border mt-6 max-w-3xl rounded-xl border p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h3 className="font-display text-lg font-semibold">
              {letter.company ? `For ${letter.company}` : "Your letter"}
            </h3>
            <button onClick={copy} className="text-brand cursor-pointer text-sm underline">
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap">{letter.text}</p>

          {letter.used.length > 0 && (
            <div className="border-border mt-4 border-t pt-4">
              <p className="font-mono text-[10px] tracking-[0.12em] uppercase opacity-60">
                Built from
              </p>
              <ul className="text-muted mt-1.5 flex flex-wrap gap-1.5 text-xs">
                {letter.used.map((u, i) => (
                  <li key={i} className="bg-surface-2 border-border rounded border px-2 py-0.5">
                    {u}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-muted mt-4 text-xs leading-relaxed">
            Read it before you send it. It goes out under your name, and the checks above
            catch invented facts — not a sentence that is true and badly put.
          </p>
        </div>
      )}
    </section>
  );
}

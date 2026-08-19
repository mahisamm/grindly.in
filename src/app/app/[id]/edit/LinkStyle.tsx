"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * How this resume prints its profile addresses.
 *
 * The interesting part of this control is that one option is worse and says so.
 * Most resume tools offer "show LinkedIn as a link" as a straightforward
 * improvement, because on screen it is tidier. What it actually does — measured,
 * not assumed — is remove the address from the PDF's text layer completely: a
 * parser reads text, not link annotations, so an application form asking for a
 * profile URL gets nothing and the readiness score records no visible link.
 *
 * So the choice is offered, because it is their document, and the consequence
 * is written next to it rather than buried in a help page. The default costs
 * nothing on either side: the address is printed AND clickable.
 */
export function LinkStyleChoice({
  resumeId,
  value,
}: {
  resumeId: string;
  value: string;
}) {
  const router = useRouter();
  const [style, setStyle] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(next: string) {
    if (next === style) return;
    const previous = style;
    setStyle(next);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/resumes/${resumeId}/link-style`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkStyle: next }),
      });
      if (!res.ok) {
        setStyle(previous);
        setError("Could not save that.");
        return;
      }
      router.refresh();
    } catch {
      setStyle(previous);
      setError("We could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-surface border-border mt-4 rounded-xl border p-5">
      <h2 className="font-display text-base font-semibold">Links in your resume</h2>
      <p className="text-muted mt-1.5 text-xs leading-relaxed">
        How your GitHub, LinkedIn and portfolio addresses are printed. Both options
        are clickable in the PDF — the difference is what a parser can read.
      </p>

      <div className="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label="Link style">
        {(
          [
            ["url", "Show the address"],
            ["label", "Show just the name"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={style === key}
            disabled={busy}
            onClick={() => void choose(key)}
            className="cursor-pointer rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors"
            style={{
              borderColor: style === key ? "var(--cta)" : "var(--line-2)",
              background: style === key ? "var(--cta)" : "transparent",
              color: style === key ? "var(--on-cta)" : "var(--muted)",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <p className="text-muted mt-3 font-mono text-[11px] leading-relaxed">
        {style === "url" ? (
          <>github.com/you · linkedin.com/in/you</>
        ) : (
          <>GitHub · LinkedIn</>
        )}
      </p>

      {style === "label" ? (
        <p
          className="mt-3 rounded-lg border p-3 text-xs leading-relaxed"
          style={{ borderColor: "var(--warn)", background: "var(--surface-2)" }}
        >
          <b>This hides the address from parsers.</b> The word stays clickable for a
          human, but the URL then exists only in the PDF&rsquo;s link annotation — which
          text extractors do not read. We measured it: the address disappears from the
          text layer entirely, so a form asking for your profile URL gets nothing, and
          your readiness score will record no visible link.
        </p>
      ) : (
        <p className="text-muted mt-3 text-xs leading-relaxed">
          Recommended. A parser reads the address, and it is still a link a human can
          click — the anchor costs the parser nothing.
        </p>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs" style={{ color: "#a3271b" }}>
          {error}
        </p>
      )}
    </div>
  );
}

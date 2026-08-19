"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The step before the editor exists.
 *
 * Reading a resume into fields costs several model calls, so it is a button
 * rather than something that happens because a page was opened. The result is
 * cached on the resume, so this screen is seen once.
 */
export function ExtractPrompt({
  resumeId,
  readable,
}: {
  resumeId: string;
  /** Whether there is enough extracted text to work from at all. */
  readable: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function extract() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/resumes/${resumeId}/struct`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "We could not read this resume into fields.");
        setBusy(false);
        return;
      }
      router.refresh();
    } catch {
      setError("We could not reach the server.");
      setBusy(false);
    }
  }

  if (!readable) {
    return (
      <div className="bg-surface border-border max-w-2xl rounded-xl border p-6">
        <h1 className="font-display text-2xl font-bold">There is nothing to edit yet</h1>
        <p className="text-muted mt-3 leading-relaxed">
          We could not extract readable text from this file, so there are no fields to
          put in front of you. That is itself the most important finding on the report:
          if we cannot read it, neither can a parser. Upload the original PDF rather
          than a scan or a screenshot.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-surface border-border max-w-2xl rounded-xl border p-6">
      <h1 className="font-display text-2xl font-bold">Edit this resume</h1>
      <p className="text-muted mt-3 leading-relaxed">
        We read your resume into fields — name, sections, entries, bullets — and you
        change them here. Then we print it to a real PDF and score it on the same ruler
        as the original, so you can see whether what you changed actually helped.
      </p>
      <p className="text-muted mt-3 text-sm leading-relaxed">
        Reading the structure takes a few seconds and counts against your daily reviews.
        It happens once; after that the editor opens straight away.
      </p>

      {error && (
        <p role="alert" className="mt-4 text-sm" style={{ color: "#a3271b" }}>
          {error}
        </p>
      )}

      <button onClick={extract} disabled={busy} className="btn btn-primary mt-5">
        {busy ? "Reading your resume…" : "Read it into fields"}
      </button>
    </div>
  );
}

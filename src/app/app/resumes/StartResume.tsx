"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function StartResume({ disabled }: { disabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/resumes/manual", { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data?.error ?? "We could not start your resume.");
        return;
      }
      router.push(`/app/${data.id}/edit`);
    } catch {
      setError("We could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bg-surface border-border flex h-full flex-col rounded-xl border p-6 sm:p-8">
      <p className="text-brand font-mono text-[11px] tracking-[0.14em] uppercase">No resume yet?</p>
      <h2 className="font-display mt-3 text-2xl font-semibold">Build it from scratch</h2>
      <p className="text-muted mt-3 flex-1 text-sm leading-relaxed">
        Add your education, projects, experience and skills in a guided editor. Build and score the
        PDF whenever you want—editing and scoring stay free.
      </p>
      <button
        type="button"
        onClick={() => void start()}
        disabled={disabled || busy}
        className="btn btn-primary mt-6 w-full justify-center"
      >
        {busy ? "Opening editor…" : disabled ? "Resume limit reached" : "Start without a resume"}
      </button>
      {error && <p role="alert" className="mt-3 text-sm" style={{ color: "#a3271b" }}>{error}</p>}
    </section>
  );
}

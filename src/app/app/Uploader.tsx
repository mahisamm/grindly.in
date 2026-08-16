"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LIMITS } from "@/lib/plans";

const ACCEPT = ".pdf,.docx,.txt";
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Drop or choose a resume.
 *
 * Client-side validation here duplicates the server's checks on purpose. The
 * server is the authority — this is untrusted and the route re-checks
 * everything — but telling someone their 40 MB file is too large after a
 * two-minute upload, rather than instantly, is a worse product for no reason.
 */
export function Uploader({ canUpload, limit }: { canUpload: boolean; limit: number }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setError(null);

    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (![".pdf", ".docx", ".txt"].includes(ext)) {
      setError("Upload a PDF, DOCX or TXT file.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("That file is larger than 5 MB.");
      return;
    }
    if (file.size === 0) {
      setError("That file is empty.");
      return;
    }

    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/resumes", { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "The upload did not work. Try again.");
        setBusy(false);
        return;
      }
      router.push(`/app/${data.id}`);
      router.refresh();
    } catch {
      setError("We could not reach the server. Check your connection.");
      setBusy(false);
    }
  }

  if (!canUpload) {
    return (
      <div className="border-border bg-surface-2 rounded-xl border p-5 text-sm">
        You are holding {limit} resume{limit === 1 ? "" : "s"}, which is your plan&rsquo;s
        limit. Open one and delete it, or{" "}
        <a href="/pricing" className="text-brand underline">
          get a Season Pass
        </a>{" "}
        for {LIMITS.pass.resumes}.
      </div>
    );
  }

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void upload(file);
        }}
        className="rounded-xl border border-dashed p-8 text-center transition-colors"
        style={{
          borderColor: dragging ? "var(--brand)" : "var(--border)",
          background: dragging ? "var(--surface-2)" : "transparent",
        }}
      >
        <p className="font-display text-lg font-semibold">
          {busy ? "Reading your resume…" : "Drop your resume here"}
        </p>
        <p className="text-muted mx-auto mt-1.5 max-w-sm text-sm leading-snug">
          {busy
            ? "Extracting the text, then scoring what a parser can recover."
            : "PDF, DOCX or TXT, up to 5 MB. We read it the way an applicant tracking system would."}
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="btn btn-primary mt-5"
        >
          {busy ? "Working…" : "Choose a file"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Reset first: choosing the SAME file twice after an error fires no
            // change event otherwise, and the retry silently does nothing.
            e.target.value = "";
            if (file) void upload(file);
          }}
        />
      </div>

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-lg border p-3 text-sm"
          style={{ borderColor: "#a3271b", color: "#a3271b" }}
        >
          {error}
        </p>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { CompanyPack } from "@/lib/reportTypes";
import { RunBanner, useRunStatus } from "../[id]/RunProgress";
import { UnlockTarget } from "../[id]/UnlockTarget";
import { TargetTab, type ResumeView } from "../[id]/Workspace";

/**
 * The client half of the Tailor page: the same small request harness the resume
 * workspace uses (a `post` helper + `useRunStatus` poller), wrapped around the
 * existing `TargetTab` from the workspace. Nothing about the tailoring UI or
 * its endpoints changed — only where it lives.
 */
export function TailorClient({
  resume,
  packs,
  disclaimer,
  targetLimit,
  paymentsLive,
  freeCompanyRebuildAvailable,
  otherResumeCount,
}: {
  resume: ResumeView;
  packs: CompanyPack[];
  disclaimer: string;
  targetLimit: number;
  paymentsLive: boolean;
  freeCompanyRebuildAvailable: boolean;
  /** Source resumes other than the primary — the "you can switch" hint. */
  otherResumeCount: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [lockedTarget, setLockedTarget] = useState<{ id: string; name: string } | null>(null);

  const { run, isRunning, refresh: refreshRun, cancel: cancelRun } = useRunStatus(resume.id);

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
        if (data?.code === "target_locked" && data?.targetId) {
          setLockedTarget({ id: String(data.targetId), name: String(data.targetName ?? "") });
          return null;
        }
        setError(data?.error ?? "That did not work.");
        if (res.status === 409) void refreshRun();
        return null;
      }
      if (data?.message) setNote(data.message);
      if (data?.runId) void refreshRun();
      else router.refresh();
      return data;
    } catch {
      setError("We could not reach the server.");
      return null;
    } finally {
      setBusy(null);
    }
  }

  const rebuilding = busy === "rewrite" || isRunning;

  return (
    <div className="mt-4">
      {otherResumeCount > 0 && (
        <p className="text-muted mb-5 text-sm">
          Tailoring <b className="text-ink">{resume.label}</b>, your primary resume.{" "}
          <Link href="/app/resumes" className="text-brand underline">
            Change which resume is primary
          </Link>
        </p>
      )}

      <RunBanner run={run} onCancel={cancelRun} />

      {lockedTarget && (
        <UnlockTarget
          targetId={lockedTarget.id}
          targetName={lockedTarget.name}
          paymentsLive={paymentsLive}
          onUnlocked={() => {
            const id = lockedTarget.id;
            setLockedTarget(null);
            setNote("Unlocked. Starting the tailored rebuild…");
            void post(`/api/resumes/${resume.id}/variants`, { targetId: id }, "rewrite");
          }}
          onDismiss={() => setLockedTarget(null)}
        />
      )}

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

      <div className="py-6">
        <TargetTab
          resume={resume}
          packs={packs}
          disclaimer={disclaimer}
          targetLimit={targetLimit}
          freeCompanyRebuildAvailable={freeCompanyRebuildAvailable}
          rebuilding={rebuilding}
          busy={busy}
          onTarget={(body) => post(`/api/resumes/${resume.id}/variants`, body, "rewrite")}
        />
      </div>
    </div>
  );
}

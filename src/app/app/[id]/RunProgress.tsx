"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The state of a rebuild, kept in the page rather than in a request.
 *
 * A batch takes one to three minutes. It used to run inside the POST, so the
 * only thing the user had was a disabled button and a sentence guessing at the
 * duration — and if the connection dropped, if they switched apps on a phone,
 * if they simply refreshed, the work carried on server-side and they never
 * found out. The run is a row now, so this hook can do the two things that were
 * impossible before: say what is actually happening, and find a run again on a
 * page that was loaded from cold.
 *
 * Polling rather than streaming. Two seconds is well inside human patience for
 * a label that changes every twenty; an SSE endpoint would need a connection
 * held open for the whole batch, which is the thing this design just removed.
 */

export type RunView = {
  id: string;
  status: "running" | "done" | "empty" | "failed" | "cancelled";
  stage: string;
  error: string | null;
  targetId: string | null;
  targetName: string;
  variantsMade: number;
  startedAt: string;
  finishedAt: string | null;
};

const POLL_MS = 2000;

/**
 * How long a finished run keeps its banner.
 *
 * Without a window, the outcome of the last batch is announced on every page
 * load forever: someone who cancelled a rebuild in March is told "Rebuild
 * stopped" every time they open that resume in August. A result is news for as
 * long as the person is plausibly still in the moment that produced it.
 */
const OUTCOME_VISIBLE_MS = 10 * 60 * 1000;

function isWorthShowing(run: RunView): boolean {
  if (run.status === "running") return true;
  const finishedAt = run.finishedAt ? new Date(run.finishedAt).getTime() : 0;
  return Date.now() - finishedAt <= OUTCOME_VISIBLE_MS;
}

export function useRunStatus(resumeId: string) {
  const router = useRouter();
  const [run, setRun] = useState<RunView | null>(null);
  const [checked, setChecked] = useState(false);
  // What the last poll saw, so the transition out of `running` can refresh the
  // page exactly once instead of on every tick afterwards.
  const wasRunning = useRef(false);

  // Whether there is any reason to keep asking. Read inside `poll` rather than
  // used to tear the interval down, so the transition from running to finished
  // is observed by the same loop that was watching for it.
  const activeRef = useRef(true);

  const poll = useCallback(async () => {
    if (!activeRef.current) return;
    try {
      const res = await fetch(`/api/resumes/${resumeId}/runs`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const latest: RunView | null = data.runs?.[0] ?? null;
      // A finished run is only worth announcing while it is still recent — see
      // OUTCOME_VISIBLE_MS. Decided HERE rather than in the banner's render:
      // reading the clock while rendering makes the component impure, and React
      // is entitled to render it twice and get two different answers.
      setRun(latest && isWorthShowing(latest) ? latest : null);

      if (wasRunning.current && latest && latest.status !== "running") {
        // The variants are in the database now; the page around this is a
        // server component and does not know that yet.
        router.refresh();
      }
      wasRunning.current = latest?.status === "running";
      // Stop polling once there is nothing in flight. A page left open on a
      // finished resume should not talk to the server every two seconds for as
      // long as the tab exists.
      activeRef.current = latest?.status === "running";
    } catch {
      // A failed poll is not worth surfacing: the next one is two seconds away,
      // and an error banner for a transient network blip on a page that is
      // otherwise working reads as a broken product.
    } finally {
      setChecked(true);
    }
  }, [resumeId, router]);

  // One read on mount, then every couple of seconds for as long as a batch is
  // running. Both live in one effect so there is a single place that decides
  // when this component talks to the server.
  //
  // The first read is scheduled rather than called straight from the effect
  // body. That is not lint appeasement: a synchronous fetch-and-set during the
  // effect competes with the paint of a page that has just navigated, and this
  // banner is the least urgent thing on it. A tick of delay costs nothing on a
  // three-minute job.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (alive) void poll();
    };

    const first = setTimeout(tick, 0);
    // The interval runs regardless of the current status, and `poll` is what
    // decides whether anything changes. Keying the interval on `run.status`
    // instead means the last poll of a finished run tears its own timer down
    // mid-flight, which is a race that shows up as a banner stuck on the
    // second-to-last stage.
    const timer = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [poll]);

  const cancel = useCallback(async () => {
    if (!run || run.status !== "running") return;
    activeRef.current = true;
    try {
      await fetch(`/api/resumes/${resumeId}/runs/${run.id}`, { method: "DELETE" });
    } catch {
      /* the poll below will report whatever actually happened */
    }
    void poll();
  }, [resumeId, run, poll]);

  /**
   * Start watching again — after this page has started a new batch.
   *
   * Polling stops when nothing is running, so a run begun after that point
   * would never be noticed without this.
   */
  const watch = useCallback(() => {
    activeRef.current = true;
    void poll();
  }, [poll]);

  return { run, checked, refresh: watch, cancel, isRunning: run?.status === "running" };
}

/**
 * The banner shown while a rebuild is under way, and immediately after one.
 *
 * Deliberately not a progress bar: the pipeline's stages are not equal lengths
 * and a bar that sits at 60% for ninety seconds is a worse lie than no bar. The
 * stage sentence is the truth and it moves often enough to show the thing is
 * alive.
 */
export function RunBanner({
  run,
  onCancel,
}: {
  run: RunView | null;
  onCancel: () => void;
}) {
  const [cancelling, setCancelling] = useState(false);

  if (!run) return null;

  if (run.status === "running") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mt-6 rounded-lg border p-4"
        style={{ borderColor: "var(--brand)", background: "var(--surface-2)" }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-medium">
              Rebuilding{run.targetName ? ` for ${run.targetName}` : ""}…
            </p>
            <p className="text-muted mt-1 text-sm">{run.stage}</p>
          </div>
          <button
            onClick={() => {
              setCancelling(true);
              onCancel();
            }}
            disabled={cancelling}
            className="text-muted hover:text-ink cursor-pointer text-sm underline"
          >
            {cancelling ? "Stopping…" : "Stop"}
          </button>
        </div>
        <p className="text-muted mt-3 text-xs leading-relaxed">
          A minute or two — several rewrites, each rendered to a real PDF and read back
          with the same extractor a parser uses. You can close this page; the work
          carries on and the results will be here when you come back.
        </p>
      </div>
    );
  }

  if (run.status === "failed") {
    return (
      <p
        role="alert"
        className="mt-6 rounded-lg border p-3 text-sm leading-snug"
        style={{ borderColor: "#a3271b", color: "#a3271b" }}
      >
        {run.error ?? "That rebuild did not finish."}
      </p>
    );
  }

  if (run.status === "empty") {
    return (
      <p
        className="mt-6 rounded-lg border p-3 text-sm leading-snug"
        style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
      >
        None of the rewrites scored higher than your current resume, so there is nothing
        here worth swapping to. That is a good sign, and you were not charged for it.
      </p>
    );
  }

  if (run.status === "cancelled") {
    return (
      <p
        className="text-muted mt-6 rounded-lg border p-3 text-sm"
        style={{ borderColor: "var(--border)" }}
      >
        Rebuild stopped. Your daily allowance was not spent.
      </p>
    );
  }

  return null;
}

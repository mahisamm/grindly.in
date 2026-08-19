/**
 * The bridge to agent/cli.py. One spawn, one JSON object each way.
 *
 * The previous build reached Python through a Postgres-backed job queue drained
 * by a long-lived worker fleet, because applying to a job board takes minutes
 * and fails halfway. Reading and rebuilding a resume takes seconds and either
 * works or doesn't, so the queue was pure cost: two extra processes to deploy,
 * a dashboard that polled every 12 seconds, and a whole class of bug where a job
 * is claimed and never released.
 *
 * Everything here is defensive about one thing in particular: a subprocess that
 * writes something other than JSON to stdout. `cli.py` swaps stdout for stderr
 * while it works precisely because the pipeline prints progress lines, but this
 * side must not *depend* on that holding — a stray `print` in a dependency, a
 * Python warning, or a missing interpreter would otherwise surface to the user
 * as an unhandled JSON parse error. So a non-JSON stdout is reported as a
 * normal failure with the first part of what was actually written, which is the
 * one piece of information that makes it debuggable.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { report } from "@/lib/errors";

export type AgentOk<T> = { ok: true } & T;
export type AgentErr = { ok: false; error: string };
export type AgentResult<T> = AgentOk<T> | AgentErr;

/** Where uploads, rendered variants and scratch files live. */
export const DATA_DIR = path.join(process.cwd(), "data");
export const RESUME_DIR = path.join(DATA_DIR, "resumes");
export const VARIANT_DIR = path.join(DATA_DIR, "variants");

/**
 * Per-command timeouts, in milliseconds.
 *
 * A variant batch runs several model calls and up to four headless Chromium
 * renders, so it is minutes rather than seconds. Everything else is local
 * computation and should finish in well under a second — giving those the same
 * generous budget would mean a hung interpreter ties up a request for five
 * minutes instead of failing fast with something the user can act on.
 */
const TIMEOUTS: Record<string, number> = {
  health: 20_000,
  ingest: 60_000,
  skills: 90_000,
  report: 120_000, // 120s only when with_advice is set; the score alone is instant
  jd: 90_000,
  companies: 15_000,
  // Two provider calls, and a cold interpreter in front of them. Longer than
  // the 60s default because timing out here is indistinguishable to the user
  // from the "we know nothing about this company" answer, and those two must
  // never look alike.
  research: 120_000,
  render: 90_000,
  // Extraction is model calls; the same budget the research lookup gets.
  struct: 120_000,
  // Local rendering only — no model, no Chromium. If this takes 30s something
  // is wrong that a longer timeout will not fix.
  export: 30_000,
  variants: 420_000,
};
const DEFAULT_TIMEOUT = 60_000;

/** Cap on what we will read off the pipes, so a runaway process can't OOM us. */
const MAX_STDOUT_BYTES = 12 * 1024 * 1024;
const MAX_STDERR_KEPT = 8 * 1024;

function pythonBin(): string {
  return process.env.PYTHON_BIN || "python";
}

export type RunOptions = {
  /**
   * Called with each `[progress] ...` line the pipeline writes while it works.
   *
   * The variant pipeline is minutes long, and its stderr already narrated what
   * it was doing to a log nobody was reading. This is that narration, delivered
   * to whoever is waiting. Never awaited and never allowed to throw: a progress
   * callback that fails must not take the run down with it.
   */
  onProgress?: (message: string) => void;
  /**
   * Called once with a function that kills the subprocess, so a caller holding
   * a long run can stop it. Handed out rather than returned because the run
   * itself is the thing being awaited.
   */
  onStart?: (kill: () => void) => void;
};

/**
 * Run one agent command.
 *
 * Never throws and never rejects. Every failure — a missing interpreter, a
 * timeout, a crash, a non-JSON reply — comes back as `{ok: false, error}` so
 * callers have exactly one shape to handle.
 */
export async function runAgent<T = Record<string, unknown>>(
  cmd: string,
  payload: Record<string, unknown> = {},
  options: RunOptions = {},
): Promise<AgentResult<T>> {
  const timeout = TIMEOUTS[cmd] ?? DEFAULT_TIMEOUT;
  const cli = path.join(process.cwd(), "agent", "cli.py");

  return new Promise<AgentResult<T>>((resolve) => {
    let child;
    try {
      child = spawn(pythonBin(), [cli], {
        cwd: process.cwd(),
        // UTF-8 on both pipes, said twice on purpose. We read stdout as utf8
        // below, and Python writes it in the locale's encoding — cp1252 on a
        // Windows dev machine — so every em dash in a finding arrived as a
        // replacement character. cli.py reconfigures its own streams; these
        // variables make it true even before the first line of that file runs,
        // which is what covers a traceback from an import failing.
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      resolve({ ok: false, error: `could not start Python: ${String(e)}` });
      return;
    }

    let out = "";
    let err = "";
    let outBytes = 0;
    let settled = false;

    try {
      options.onStart?.(() => child.kill("SIGKILL"));
    } catch {
      /* a caller that cannot hold the handle does not get to stop the run */
    }

    const finish = (result: AgentResult<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      report({
        source: "agent",
        kind: "timeout",
        message: `${cmd} exceeded ${Math.round(timeout / 1000)}s and was killed`,
        context: cmd,
      });
      finish({
        ok: false,
        error: `the ${cmd} step took longer than ${Math.round(timeout / 1000)}s and was stopped`,
      });
    }, timeout);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outBytes += Buffer.byteLength(chunk);
      if (outBytes > MAX_STDOUT_BYTES) {
        child.kill("SIGKILL");
        finish({ ok: false, error: `the ${cmd} step produced an implausible amount of output` });
        return;
      }
      out += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Keep only the tail: a traceback's last frames are the part anyone reads,
      // and an unbounded buffer here is a memory leak with a stack trace.
      err = (err + chunk).slice(-MAX_STDERR_KEPT);

      if (!options.onProgress) return;
      // Progress lines are read off the raw chunk rather than the kept tail, so
      // a long traceback later in the run cannot push earlier progress out of
      // the buffer before it has been seen. A chunk can split a line, which
      // costs at most one missed update — not worth a reassembly buffer for a
      // label that is replaced seconds later anyway.
      for (const line of chunk.split(/\r?\n/)) {
        const match = line.match(/^\[progress\]\s+(.*)$/);
        if (!match) continue;
        try {
          options.onProgress(match[1].trim().slice(0, 200));
        } catch {
          /* never let a progress listener break the run it is watching */
        }
      }
    });

    child.on("error", (e) => {
      const hint =
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? `Python was not found at PYTHON_BIN="${pythonBin()}". Set PYTHON_BIN in .env to the interpreter that has agent/requirements.txt installed.`
          : String(e);
      report({ source: "agent", kind: "spawn-failed", message: hint, context: cmd });
      finish({ ok: false, error: hint });
    });

    child.on("close", (code) => {
      const text = out.trim();
      if (!text) {
        report({
          source: "agent",
          kind: "no-output",
          message: `${cmd} wrote nothing to stdout (exit ${code})`,
          stack: err,
          context: cmd,
        });
        finish({
          ok: false,
          error:
            code === 0
              ? `the ${cmd} step returned nothing`
              : `the ${cmd} step failed (exit ${code})`,
        });
        return;
      }
      try {
        const parsed = JSON.parse(text) as AgentResult<T>;
        if (typeof parsed !== "object" || parsed === null || !("ok" in parsed)) {
          finish({ ok: false, error: `the ${cmd} step returned an unexpected shape` });
          return;
        }
        if (!parsed.ok) {
          report({
            source: "agent",
            kind: `${cmd}-failed`,
            message: parsed.error,
            stack: err,
            context: cmd,
          });
        }
        finish(parsed);
      } catch {
        // The single most useful thing to record is what was actually written —
        // that string is the whole diagnosis.
        report({
          source: "agent",
          kind: "malformed-output",
          message: `${cmd} stdout was not JSON: ${text.slice(0, 300)}`,
          stack: err,
          context: cmd,
        });
        finish({ ok: false, error: `the ${cmd} step returned malformed output` });
      }
    });

    try {
      child.stdin.end(JSON.stringify({ cmd, ...payload }));
    } catch (e) {
      finish({ ok: false, error: `could not send input to Python: ${String(e)}` });
    }
  });
}

// ---------------------------------------------------------------------------
// Shapes shared with the browser live in lib/reportTypes.ts, which imports no
// Node built-ins. Re-exported as TYPES ONLY: a client component that imports a
// value from this module pulls `node:child_process` into the browser bundle and
// the build fails outright.
// ---------------------------------------------------------------------------

export type {
  Advice,
  Band,
  CompanyPack,
  CompanyResearch,
  CompanySource,
  Fidelity,
  Finding,
  JobSpec,
  Report,
  Severity,
} from "@/lib/reportTypes";

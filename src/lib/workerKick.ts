import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const MAX_LOG_BYTES = 1 * 1024 * 1024; // 1 MB per-user log cap

/**
 * Best-effort local "kick" of the Python worker so a dev box without
 * `worker.py --serve` running still drains queued jobs immediately. No-ops
 * silently if Python isn't present (e.g. the slim prod web image) — the
 * worker fleet drains the DB-backed queue on its own.
 *
 * Truncates the per-user log before appending once it exceeds MAX_LOG_BYTES —
 * these files aren't rotated by anything else, so left alone they grow
 * forever (one file per user, appended to on every resume upload / run).
 */
export function spawnWorkerKick(root: string, uid: string) {
  const worker = path.join(root, "agent", "worker.py");
  const logDir = path.join(root, "data", "logs");
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `${uid}.log`);
    let flag: "a" | "w" = "a";
    try {
      if (fs.statSync(logPath).size > MAX_LOG_BYTES) flag = "w";
    } catch {
      // file doesn't exist yet — append is fine, creates it
    }
    const out = fs.openSync(logPath, flag);
    const py = process.env.PYTHON_BIN || "python";
    const child = spawn(py, [worker, "--drain"], {
      cwd: root,
      detached: true,
      stdio: ["ignore", out, out],
    });
    fs.closeSync(out);
    child.on("error", () => {}); // bad executable surfaces async — ignore; worker fleet drains
    child.unref();
  } catch {
    // No Python here — the worker fleet drains the queue separately.
  }
}

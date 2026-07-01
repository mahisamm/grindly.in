import fs from "node:fs";
import path from "node:path";

const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2 MB cap

/**
 * Opens a worker log file for appending, rotating it if it exceeds 2 MB.
 * Returns a file descriptor suitable for use as stdio[1]/stdio[2] in spawn().
 */
export function openWorkerLog(logDir: string, name: string): number {
  const logPath = path.join(logDir, `${name}.log`);
  try {
    const stat = fs.statSync(logPath);
    if (stat.size >= MAX_LOG_BYTES) {
      // Rotate: rename current log to .log.1, discarding any older rotation
      const rotated = logPath + ".1";
      if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
      fs.renameSync(logPath, rotated);
    }
  } catch {
    // File doesn't exist yet — fine
  }
  return fs.openSync(logPath, "a");
}

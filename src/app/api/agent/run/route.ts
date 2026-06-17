import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";

/**
 * Triggers one agent run for the current user (resume parse → match → apply →
 * report). Spawns the Python worker detached so the request returns instantly;
 * the worker writes results back to the same SQLite DB the dashboard polls.
 *
 * `mode=mock` (default) runs against the bundled mock board — safe to demo.
 * `mode=live` drives real Internshala via Playwright.
 */
export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { mode } = (await req.json().catch(() => ({}))) as { mode?: string };
  const runMode = mode === "live" ? "live" : "mock";

  const user = await prisma.user.findUnique({ where: { id: uid } });
  if (!user) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!user.paid) return NextResponse.json({ error: "payment required" }, { status: 402 });

  const root = process.cwd();
  const worker = path.join(root, "agent", "worker.py");
  if (!fs.existsSync(worker)) {
    return NextResponse.json({ error: "worker not installed" }, { status: 500 });
  }

  const logDir = path.join(root, "data", "logs");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, `${uid}.log`), "a");

  const py = process.env.PYTHON_BIN || "python";
  const child = spawn(py, [worker, "--user", uid, "--mode", runMode, "--once"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();

  return NextResponse.json({ ok: true, mode: runMode, pid: child.pid });
}

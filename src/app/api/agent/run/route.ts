import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
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

  const { mode, analyzeOnly } = (await req.json().catch(() => ({}))) as { mode?: string; analyzeOnly?: boolean };
  const runMode = mode === "live" ? "live" : "mock";

  const user = await prisma.user.findUnique({ where: { id: uid } });
  if (!user) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!user.paid) return NextResponse.json({ error: "payment required" }, { status: 402 });

  const root = process.cwd();
  const worker = path.join(root, "agent", "worker.py");
  try { await fsp.access(worker); } catch {
    return NextResponse.json({ error: "worker not installed" }, { status: 500 });
  }

  const logDir = path.join(root, "data", "logs");
  await fsp.mkdir(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, `${uid}.log`), "a");

  const py = process.env.PYTHON_BIN || "python";

  let runId: string | null = null;
  let args: string[];
  if (analyzeOnly) {
    args = [worker, "--user", uid, "--analyze"];
  } else {
    // Enqueue a run (idempotent: reuse any queued/running job for this user),
    // then drain the queue. Gives retries + per-user locking + crash recovery.
    const existing = await prisma.agentRun.findFirst({
      where: { userId: uid, status: { in: ["queued", "running"] } },
    });
    const run = existing ?? (await prisma.agentRun.create({ data: { userId: uid, mode: runMode } }));
    runId = run.id;
    args = [worker, "--drain"];
  }

  let child;
  try {
    child = spawn(py, args, { cwd: root, detached: true, stdio: ["ignore", out, out] });
  } catch {
    return NextResponse.json(
      { error: `could not start the agent (PYTHON_BIN="${py}"). Is Python installed?` },
      { status: 500 },
    );
  }
  // spawn() reports a bad executable asynchronously via 'error'
  child.on("error", () => {});
  child.unref();

  return NextResponse.json({ ok: true, mode: analyzeOnly ? "analyze" : runMode, runId, pid: child.pid });
}

/**
 * GET /api/agent/run?id=<runId> — poll the result of a run the dashboard kicked
 * off, so the UI can show "applied X / matched Y" or a real error instead of a
 * blind 6-second spinner.
 */
export async function GET(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });

  const run = await prisma.agentRun.findFirst({ where: { id, userId: uid } });
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });

  let result: unknown = null;
  if (run.result) { try { result = JSON.parse(run.result); } catch { result = null; } }

  return NextResponse.json({
    status: run.status, // queued | running | done | failed | cancelled
    result,
    error: run.error ?? null,
  });
}

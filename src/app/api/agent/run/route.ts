import { NextResponse } from "next/server";
import path from "node:path";
import fsp from "node:fs/promises";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { spawnWorkerKick } from "@/lib/workerKick";

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

  const root = process.cwd();
  const worker = path.join(root, "agent", "worker.py");
  try { await fsp.access(worker); } catch {
    return NextResponse.json({ error: "worker not installed" }, { status: 500 });
  }

  // Enqueue in the DB-backed run queue (idempotent: reuse any queued/running job
  // for this user). The worker fleet (worker.py --serve) drains it — so the web
  // app does NOT need Python. The spawn below is only a best-effort local "kick"
  // so a dev box without a running worker processes immediately; in prod (slim
  // web image) it no-ops and the worker drains the queue.
  let run;
  if (analyzeOnly) {
    run = await prisma.agentRun.create({ data: { userId: uid, mode: "analyze" } });
  } else {
    const existing = await prisma.agentRun.findFirst({
      where: { userId: uid, status: { in: ["queued", "running"] } },
    });
    run = existing ?? (await prisma.agentRun.create({ data: { userId: uid, mode: runMode } }));
  }

  spawnWorkerKick(root, uid);

  return NextResponse.json({ ok: true, mode: analyzeOnly ? "analyze" : runMode, runId: run.id });
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

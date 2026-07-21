import { NextResponse } from "next/server";
import path from "node:path";
import fsp from "node:fs/promises";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { spawnWorkerKick } from "@/lib/workerKick";
import { getQuota } from "@/lib/quota";
import { enqueueAgentRun } from "@/lib/agentRunQueue";
import { hasAppAccess } from "@/lib/access";
import { readAdminSettings } from "@/lib/adminSettings";

/**
 * Triggers one agent run for the current user (resume parse → match → apply →
 * report). Spawns the Python worker detached so the request returns instantly;
 * the worker writes results back to the same SQLite DB the dashboard polls.
 *
 * Always runs live against the user's connected platform (Internshala) via
 * Playwright. `analyzeOnly` runs resume analysis without touching any board.
 */
export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { analyzeOnly, optimize } = (await req.json().catch(() => ({}))) as {
    analyzeOnly?: boolean;
    optimize?: boolean;
  };

  const user = await prisma.user.findUnique({ where: { id: uid } });
  if (!user) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Gated beta: an unapproved account can never make the agent do work, even by
  // calling this route directly. The dashboard shows the waitlist instead.
  if (!hasAppAccess(user)) {
    return NextResponse.json(
      { error: "Your access is pending approval.", code: "access_pending" },
      { status: 403 },
    );
  }

  // ATS-optimized resume variants ("show me 3 better versions"). A resume-only,
  // platform-free background job — no quota, no connected-platform requirement,
  // and allowed during maintenance since it never touches a job board. Enqueues
  // the worker's "optimize" mode; the dashboard polls this run's id like analyze.
  if (optimize) {
    const profile = await prisma.profile.findUnique({
      where: { userId: uid },
      select: { resumeName: true, resumeScore: true },
    });
    if (!profile?.resumeName) {
      return NextResponse.json({ error: "Upload a resume first." }, { status: 400 });
    }
    if (profile.resumeScore == null) {
      return NextResponse.json(
        { error: "Your resume is still being analyzed — try again in a moment." },
        { status: 409 },
      );
    }
    const root = process.cwd();
    try {
      await fsp.access(path.join(root, "agent", "worker.py"));
    } catch {
      return NextResponse.json({ error: "worker not installed" }, { status: 500 });
    }
    // Flip the status now so the card shows "Building…" instantly; the worker
    // overwrites it with ready / no_gain / failed when it finishes.
    await prisma.profile
      .update({
        where: { userId: uid },
        data: { resumeVariantStatus: "generating", resumeVariantDetail: "Building optimized versions…" },
      })
      .catch(() => {});
    const optRun = await enqueueAgentRun(uid, "optimize");
    spawnWorkerKick(root, uid);
    return NextResponse.json({ ok: true, mode: "optimize", runId: optRun.id });
  }

  const settings = readAdminSettings();
  if (settings.maintenanceMode) {
    return NextResponse.json(
      { error: "Grindly is in maintenance. Agent runs are paused — try again shortly.", code: "maintenance" },
      { status: 503 },
    );
  }

  // Live only — there is no mock/demo mode. The agent applies to real listings
  // via the user's connected platform, so nothing fabricated reaches the UI.
  const runMode = "live";

  // A live run applies against a connected platform — without one the worker can
  // only report login_required, so refuse up front instead of enqueueing a
  // doomed job. `analyzeOnly` just scores the resume and needs no platform.
  // (The dashboard already disables the button; this enforces it server-side so
  // a direct API call can't queue a run with nothing connected.)
  if (!analyzeOnly) {
    if (!settings.featureFlags.autoApply) {
      return NextResponse.json(
        { error: "Auto-apply is temporarily disabled by an admin.", code: "auto_apply_disabled" },
        { status: 403 },
      );
    }
    const quota = await getQuota(uid, user.plan);
    if (quota.remaining === 0) {
      return NextResponse.json(
        {
          error: `You've reached today's limit of ${quota.cap} applications. The agent picks up again tomorrow.`,
          code: "daily_limit_reached",
          quota,
        },
        { status: 402 },
      );
    }
    if (settings.globalDailyCap > 0) {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const globalToday = await prisma.application.count({
        where: { status: "applied", appliedAt: { gte: start } },
      });
      if (globalToday >= settings.globalDailyCap) {
        return NextResponse.json(
          { error: "Grindly has hit today's global application cap. The agent picks up again tomorrow.", code: "global_limit_reached" },
          { status: 402 },
        );
      }
    }
    const connected =
      user.internshalaConnected ||
      (await prisma.userIntegration
        .count({ where: { userId: uid, status: "connected" } })
        .catch(() => 0)) > 0;
    if (!connected) {
      return NextResponse.json(
        { error: "Connect at least one job platform before running the agent." },
        { status: 400 },
      );
    }
  }

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
    run = await enqueueAgentRun(uid, "analyze");
  } else {
    const existing = await prisma.agentRun.findFirst({
      where: { userId: uid, status: { in: ["queued", "running"] } },
    });
    run = await enqueueAgentRun(uid, runMode, existing);
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

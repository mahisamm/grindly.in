import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { execSync } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { missingBetaAutomationConfig } from "@/lib/serverConfig";

export const dynamic = "force-dynamic";

type CheckResult = { ok: boolean; detail: string };

async function checkDb(): Promise<CheckResult> {
  try {
    const count = await prisma.user.count();
    return { ok: true, detail: `${count} user(s) in DB` };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

// Python + Playwright live in the WORKER container, not the web image that
// serves this route. So we try locally first (covers single-process dev), and
// when python isn't on the web box we infer worker-runtime health from recent
// agent runs instead of flashing a false red. A run that reached running/done
// proves the worker booted python + playwright.
async function inferWorkerRuntime(label: string, hint: string): Promise<CheckResult> {
  try {
    const run = await prisma.agentRun.findFirst({
      where: { status: { in: ["running", "done"] } },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    });
    if (!run) {
      return { ok: true, detail: `${label} runs in the worker container — no agent run yet to verify (${hint})` };
    }
    const hoursAgo = Math.round((Date.now() - new Date(run.updatedAt).getTime()) / 3_600_000);
    if (hoursAgo <= 26) return { ok: true, detail: `${label} verified in worker container (last run ${hoursAgo}h ago)` };
    return { ok: false, detail: `${label} unverified — no worker run in ${hoursAgo}h, worker may be down` };
  } catch (e) {
    return { ok: false, detail: `${label} check failed: ${String(e)}` };
  }
}

async function checkPython(): Promise<CheckResult> {
  try {
    const bin = process.env.PYTHON_BIN ?? "python";
    const out = execSync(`${bin} --version`, { timeout: 5000 }).toString().trim();
    return { ok: true, detail: `${out} (web container)` };
  } catch {
    return inferWorkerRuntime("Python", "expected — slim web image has no python");
  }
}

async function checkPlaywright(): Promise<CheckResult> {
  try {
    const bin = process.env.PYTHON_BIN ?? "python";
    execSync(`${bin} -c "import playwright"`, { timeout: 5000 });
    // Check for chromium binary
    const homePath = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const chromiumPaths = [
      path.join(homePath, ".cache/ms-playwright"),
      path.join(homePath, "AppData/Local/ms-playwright"),
    ];
    const found = chromiumPaths.some((p) => existsSync(p));
    return { ok: found, detail: found ? "playwright + chromium present (web container)" : "playwright installed but chromium not found" };
  } catch {
    return inferWorkerRuntime("Playwright + Chromium", "expected — slim web image has no playwright");
  }
}

async function checkProfiles(): Promise<CheckResult> {
  try {
    const withResume = await prisma.profile.count({ where: { OR: [{ resumeText: { not: null } }, { resumeName: { not: null } }] } });
    const total = await prisma.profile.count();
    if (total === 0) return { ok: true, detail: "No users yet — agent ready once users sign up" };
    return { ok: withResume > 0, detail: `${withResume}/${total} profiles have a resume` };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

async function checkSessions(): Promise<CheckResult> {
  try {
    const connected = await prisma.userIntegration.count({ where: { status: "connected" } });
    const needsLogin = await prisma.userIntegration.count({ where: { status: "needs_login" } });
    if (connected === 0 && needsLogin === 0) return { ok: true, detail: "No sessions yet — users connect via dashboard" };
    if (needsLogin > 0) return { ok: false, detail: `${connected} connected · ${needsLogin} need re-login` };
    return { ok: true, detail: `${connected} platform session(s) connected` };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

function checkAgentFiles(): CheckResult {
  const agentDir = path.join(process.cwd(), "agent");
  const required = ["internshala.py", "matcher.py", "db.py", "run_queue.py"];
  const missing = required.filter((f) => !existsSync(path.join(agentDir, f)));
  if (missing.length) return { ok: false, detail: `Missing: ${missing.join(", ")}` };
  return { ok: true, detail: `Core agent files present (${required.length} checked)` };
}

async function checkLastRun(): Promise<CheckResult> {
  try {
    const run = await prisma.agentRun.findFirst({ orderBy: { updatedAt: "desc" }, select: { status: true, updatedAt: true, error: true } });
    if (!run) return { ok: false, detail: "No agent runs recorded yet" };
    const hoursAgo = Math.round((Date.now() - new Date(run.updatedAt).getTime()) / 3_600_000);
    if (run.status === "failed") return { ok: false, detail: `Last run failed ${hoursAgo}h ago: ${run.error ?? "unknown error"}` };
    if (hoursAgo > 26) return { ok: false, detail: `Last run ${hoursAgo}h ago — cron may have stopped` };
    return { ok: true, detail: `Last run ${hoursAgo}h ago (${run.status})` };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

/**
 * The last seven days of the pipeline, by day.
 *
 * The worker logs a one-line `funnel:` per run, which is the right thing while
 * you are watching a run and useless the next morning — container logs rotate
 * and nobody greps them until a user complains. The applications table is the
 * durable record of the same story, so the question "where did a slow day die"
 * survives a redeploy.
 *
 * Aggregated in JS rather than SQL on purpose: a week of one fleet's rows is
 * hundreds, not millions, and date bucketing in raw SQL would tie this route
 * to Postgres while the agent's own tests run on SQLite.
 */
async function weeklyFunnel() {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await prisma.application.findMany({
    where: { createdAt: { gte: since } },
    select: { createdAt: true, status: true, applyTier: true, applyChannel: true },
  });

  const byDay = new Map<
    string,
    { day: string; scored: number; matched: number; sent: number; failed: number; needsReview: number; sendable: number }
  >();
  for (const r of rows) {
    const day = r.createdAt.toISOString().slice(0, 10);
    const d =
      byDay.get(day) ??
      { day, scored: 0, matched: 0, sent: 0, failed: 0, needsReview: 0, sendable: 0 };
    d.scored += 1;
    if (r.status === "matched" || r.status === "approved") d.matched += 1;
    if (r.status === "applied") d.sent += 1;
    if (r.status === "failed") d.failed += 1;
    if (r.status === "needs_review") d.needsReview += 1;
    // Tier C is never submitted from our servers, so counting it as pipeline
    // is how "43 in queue" came to mean "43 things the agent cannot send".
    if (r.status !== "skipped" && r.applyTier && r.applyTier !== "C") d.sendable += 1;
    byDay.set(day, d);
  }

  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export async function GET() {
  const g = await requireAdmin();
  if ("error" in g) return g.error;

  const [db, python, playwright, profiles, sessions, agentFiles, lastRun] = await Promise.all([
    checkDb(),
    checkPython(),
    checkPlaywright(),
    checkProfiles(),
    checkSessions(),
    Promise.resolve(checkAgentFiles()),
    checkLastRun(),
  ]);

  const betaMissing = missingBetaAutomationConfig();
  const checks = [
    { id: "db", label: "Database connection", ...db },
    { id: "python", label: "Python runtime", ...python },
    { id: "playwright", label: "Playwright + Chromium", ...playwright },
    { id: "agent_files", label: "Agent core files", ...agentFiles },
    { id: "profiles", label: "User profiles with resume", ...profiles },
    { id: "sessions", label: "Platform sessions", ...sessions },
    { id: "last_run", label: "Last agent run", ...lastRun },
    {
      id: "beta_automation",
      label: "Beta automation configuration",
      ok: betaMissing.length === 0,
      detail: betaMissing.length
        ? `Missing: ${betaMissing.join("; ")}`
        : "Web discovery, direct submit, browser executor, ATS and daily email are enabled",
    },
  ];

  const allOk = checks.every((c) => c.ok);

  // Queue depth stats
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
  const [queueDepth, runningCount, staleCount, recentFailed, funnel, lastHarvest] =
    await Promise.all([
      prisma.agentRun.count({ where: { status: "queued" } }),
      prisma.agentRun.count({ where: { status: "running" } }),
      prisma.agentRun.count({ where: { status: "running", lockedAt: { lt: thirtyMinAgo } } }),
      prisma.agentRun.findMany({
        where: { status: "failed" },
        orderBy: { updatedAt: "desc" },
        take: 5,
        select: { userId: true, error: true, updatedAt: true },
      }),
      weeklyFunnel(),
      prisma.auditLog.findFirst({
        where: { action: "board_harvest" },
        orderBy: { createdAt: "desc" },
        select: { target: true, detail: true, createdAt: true },
      }),
    ]);

  return NextResponse.json({
    checks,
    allOk,
    checkedAt: new Date().toISOString(),
    queue: { queueDepth, runningCount, staleCount, recentFailed },
    funnel,
    lastHarvest,
  });
}

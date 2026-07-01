import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { execSync } from "child_process";
import { existsSync } from "fs";
import path from "path";

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

function checkPython(): CheckResult {
  try {
    const bin = process.env.PYTHON_BIN ?? "python";
    const out = execSync(`${bin} --version`, { timeout: 5000 }).toString().trim();
    return { ok: true, detail: out };
  } catch (e) {
    return { ok: false, detail: `Python not found: ${String(e)}` };
  }
}

function checkPlaywright(): CheckResult {
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
    return { ok: found, detail: found ? "playwright + chromium present" : "playwright installed but chromium not found" };
  } catch {
    return { ok: false, detail: "playwright not installed (run: pip install playwright && playwright install chromium)" };
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

export async function GET() {
  const g = await requireAdmin();
  if ("error" in g) return g.error;

  const [db, python, playwright, profiles, sessions, agentFiles, lastRun] = await Promise.all([
    checkDb(),
    Promise.resolve(checkPython()),
    Promise.resolve(checkPlaywright()),
    checkProfiles(),
    checkSessions(),
    Promise.resolve(checkAgentFiles()),
    checkLastRun(),
  ]);

  const checks = [
    { id: "db", label: "Database connection", ...db },
    { id: "python", label: "Python runtime", ...python },
    { id: "playwright", label: "Playwright + Chromium", ...playwright },
    { id: "agent_files", label: "Agent core files", ...agentFiles },
    { id: "profiles", label: "User profiles with resume", ...profiles },
    { id: "sessions", label: "Platform sessions", ...sessions },
    { id: "last_run", label: "Last agent run", ...lastRun },
  ];

  const allOk = checks.every((c) => c.ok);

  // Queue depth stats
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
  const [queueDepth, runningCount, staleCount, recentFailed] = await Promise.all([
    prisma.agentRun.count({ where: { status: "queued" } }),
    prisma.agentRun.count({ where: { status: "running" } }),
    prisma.agentRun.count({ where: { status: "running", lockedAt: { lt: thirtyMinAgo } } }),
    prisma.agentRun.findMany({
      where: { status: "failed" },
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: { userId: true, error: true, updatedAt: true },
    }),
  ]);

  return NextResponse.json({
    checks,
    allOk,
    checkedAt: new Date().toISOString(),
    queue: { queueDepth, runningCount, staleCount, recentFailed },
  });
}

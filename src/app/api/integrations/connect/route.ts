import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { getUid } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { hasAppAccess } from "@/lib/access";

const ALLOWED = ["internshala"];

/**
 * POST /api/integrations/connect  body: { platform: string }
 *
 * Marks user_integrations.status='connecting'. Two different things pick
 * that up depending on environment:
 *
 *   - Production: agent/connect_service.py (a separate always-running
 *     container, see docker-compose's `connect` service) polls for this
 *     status, opens a real headed browser on an isolated Xvfb display, and
 *     issues a short-lived token so the dashboard can show the user a live
 *     view of that browser to log into themselves — see connectToken on
 *     GET /api/integrations and src/components/ConnectViewer.tsx. Grindly
 *     never sees or stores the password, only the resulting session.
 *
 *   - Dev: no connect service running locally, so this spawns
 *     connect_platform.py directly — same headed-browser flow, just
 *     literally on the developer's own screen instead of streamed.
 */
export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { platform: rawPlatform } = (await req.json().catch(() => ({}))) as { platform?: string };
  if (!rawPlatform || !ALLOWED.includes(rawPlatform)) {
    return NextResponse.json({ error: "invalid platform" }, { status: 400 });
  }
  const platform = rawPlatform;

  const user = await prisma.user.findUnique({ where: { id: uid } });
  if (!user) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Approval-gated beta: a pending account must not be able to start a real
  // connect session (the prod connect-service spins up a scarce headed browser).
  // Same guard the agent/run + approve routes use; without it a gated user could
  // both bypass the gate and tie up the shared login display.
  if (!hasAppAccess(user)) {
    return NextResponse.json(
      { error: "Your access is pending approval.", code: "access_pending" },
      { status: 403 },
    );
  }

  // Mark as "connecting" in DB — the sole signal both paths below rely on.
  try {
    await prisma.userIntegration.upsert({
      where: { userId_platform: { userId: uid, platform } },
      update: { status: "connecting" },
      create: { userId: uid, platform, status: "connecting" },
    });
  } catch {
    // Table might not exist until prisma db push runs; still proceed —
    // dev-spawn / prod-polling can pick this up once the schema lands.
  }

  if (process.env.NODE_ENV === "production") {
    // The `connect` service container does the actual work — nothing more
    // for this request to do. Frontend polls GET /api/integrations for a
    // connectToken to appear, then opens the remote-browser viewer.
    return NextResponse.json({ ok: true, platform, mode: "remote" });
  }

  const root = process.cwd();
  const script = path.join(root, "agent", "connect_platform.py");
  if (!fs.existsSync(script)) {
    return NextResponse.json({ error: "connect script missing" }, { status: 500 });
  }

  const logDir = path.join(root, "data", "logs");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, `${uid}-${platform}-connect.log`), "a");

  const py = process.env.PYTHON_BIN || "python";
  let child;
  try {
    child = spawn(
      py,
      [script, "--user", uid, "--platform", platform, "--timeout", "300"],
      { cwd: root, detached: true, stdio: ["ignore", out, out] },
    );
  } catch {
    return NextResponse.json(
      { error: `could not open the login browser (PYTHON_BIN="${py}"). Is Python + Playwright installed? Run \`npm run setup\`.` },
      { status: 500 },
    );
  }
  child.on("error", () => {});
  child.unref();

  return NextResponse.json({ ok: true, platform, mode: "local", pid: child.pid });
}

import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { getUid } from "@/lib/session";
import { prisma } from "@/lib/prisma";

const ALLOWED = ["linkedin", "internshala", "naukri", "unstop", "indeed"];

/**
 * POST /api/integrations/connect  body: { platform: string }
 *
 * Spawns connect_platform.py detached — opens a headed browser window
 * so the user logs in once. The script writes user_integrations.status='connected'
 * when login is detected; the dashboard polls /api/integrations until it flips.
 */
export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { platform } = (await req.json().catch(() => ({}))) as { platform?: string };
  if (!platform || !ALLOWED.includes(platform)) {
    return NextResponse.json({ error: "invalid platform" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { id: uid } });
  if (!user) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Live platform-connect drives a HEADED browser the user logs into — only
  // possible on the user's own machine. A hosted server has no display, so this
  // is disabled in production until the remote-browser flow lands (Phase 4).
  // Mock agent runs still work without connecting a platform.
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "Connecting job platforms isn't available in the hosted beta yet — live auto-apply is coming soon." },
      { status: 503 },
    );
  }

  const root = process.cwd();
  const script = path.join(root, "agent", "connect_platform.py");
  if (!fs.existsSync(script)) {
    return NextResponse.json({ error: "connect script missing" }, { status: 500 });
  }

  const logDir = path.join(root, "data", "logs");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, `${uid}-${platform}-connect.log`), "a");

  // Mark as "connecting" in DB so dashboard can show a pending state
  try {
    await prisma.userIntegration.upsert({
      where: { userId_platform: { userId: uid, platform } },
      update: { status: "connecting" },
      create: { userId: uid, platform, status: "connecting" },
    });
  } catch {
    // Table might not exist until prisma db push runs; browser will still open
  }

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

  return NextResponse.json({ ok: true, platform, pid: child.pid });
}

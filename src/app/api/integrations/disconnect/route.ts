import { NextResponse } from "next/server";
import path from "node:path";
import fsp from "node:fs/promises";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";

const ALLOWED = ["linkedin", "internshala", "naukri", "unstop", "indeed"];

export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { platform: rawPlatform } = (await req.json().catch(() => ({}))) as { platform?: string };
  if (!rawPlatform || !ALLOWED.includes(rawPlatform)) {
    return NextResponse.json({ error: "invalid platform" }, { status: 400 });
  }
  const platform = rawPlatform;

  try {
    await prisma.userIntegration.upsert({
      where: { userId_platform: { userId: uid, platform } },
      update: { status: "disconnected", connectedAt: null },
      create: { userId: uid, platform, status: "disconnected" },
    });

    if (platform === "internshala") {
      await prisma.user.update({
        where: { id: uid },
        data: { internshalaConnected: false },
      });
    }
  } catch {
    // Ignore if table not yet migrated
  }

  // Actually revoke the session, not just the DB flag: delete the persistent
  // browser profile (real login cookies) from the shared appdata volume.
  // Without this, "disconnect" is cosmetic — the saved login stays reusable
  // on disk, so the agent (or a bug) could keep acting as the user after
  // they believed they'd revoked access. Must match agent/*.py _profile_dir():
  // data/browser_profile/<uid>/<platform>.
  try {
    const profileDir = path.join(process.cwd(), "data", "browser_profile", uid, platform);
    await fsp.rm(profileDir, { recursive: true, force: true });
  } catch {
    // Best-effort: a missing dir (never connected on this host) is fine.
  }

  return NextResponse.json({ ok: true, platform });
}

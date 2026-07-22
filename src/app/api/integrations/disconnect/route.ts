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

  // Withdraw still-pending matches that came from the platform being removed.
  //
  // Disconnecting already stops FUTURE discovery (agent/db.get_connected_platforms
  // only returns status='connected'). But matches ALREADY found on this platform
  // sit in the pipeline as status='matched' rows — including future-dated ones the
  // user hasn't seen yet — and keep surfacing as "LinkedIn matches" on a platform
  // the user just disconnected. With the login gone they can never be submitted
  // anyway. So drop the not-yet-sent ones (matched / approved / needs_review).
  // Applied, failed and skipped rows are a real history record and are kept.
  // Platform lives on the linked Job (Application has no source column), and
  // deleteMany can't filter across a relation — so resolve ids first, then delete.
  try {
    const pending = await prisma.application.findMany({
      where: {
        userId: uid,
        status: { in: ["matched", "approved", "needs_review"] },
        job: { source: platform },
      },
      select: { id: true },
    });
    if (pending.length) {
      await prisma.application.deleteMany({
        where: { id: { in: pending.map((p) => p.id) } },
      });
    }
  } catch {
    // Best-effort: a cleanup failure must never fail the disconnect itself.
  }

  return NextResponse.json({ ok: true, platform });
}

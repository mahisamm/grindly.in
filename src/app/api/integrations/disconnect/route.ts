import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";

const ALLOWED = ["linkedin", "internshala", "naukri", "unstop", "indeed"];

export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { platform } = (await req.json().catch(() => ({}))) as { platform?: string };
  if (!platform || !ALLOWED.includes(platform)) {
    return NextResponse.json({ error: "invalid platform" }, { status: 400 });
  }

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

  return NextResponse.json({ ok: true, platform });
}

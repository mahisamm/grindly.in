import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";

const PLATFORMS = ["linkedin", "internshala", "naukri", "unstop", "indeed"] as const;

export async function GET() {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  let rows: { platform: string; status: string; connectedAt: Date | null }[] = [];
  try {
    rows = await prisma.userIntegration.findMany({ where: { userId: uid } });
  } catch {
    // Table may not exist yet if prisma db push hasn't run; return defaults.
  }

  const byPlatform = Object.fromEntries(rows.map((r) => [r.platform, r]));
  const integrations = PLATFORMS.map((p) => ({
    platform: p,
    status: byPlatform[p]?.status ?? "disconnected",
    connectedAt: byPlatform[p]?.connectedAt ?? null,
  }));

  return NextResponse.json({ integrations });
}

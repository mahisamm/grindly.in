import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";

// Internshala is the only board the agent can actually submit on. The other
// four were crawled for months and contributed zero listings to the pool, and
// were graded TIER_C besides — connecting them linked the user to nothing.
const PLATFORMS = ["internshala"] as const;

export async function GET() {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  let rows: {
    platform: string;
    status: string;
    connectedAt: Date | null;
    connectToken: string | null;
    connectTokenExpiresAt: Date | null;
  }[] = [];
  try {
    rows = await prisma.userIntegration.findMany({ where: { userId: uid } });
  } catch {
    // Table may not exist yet if prisma db push hasn't run; return defaults.
  }

  const byPlatform = Object.fromEntries(rows.map((r) => [r.platform, r]));
  const now = Date.now();
  const integrations = PLATFORMS.map((p) => {
    const row = byPlatform[p];
    const tokenLive =
      row?.connectToken && row?.connectTokenExpiresAt && new Date(row.connectTokenExpiresAt).getTime() > now;
    return {
      platform: p,
      status: row?.status ?? "disconnected",
      connectedAt: row?.connectedAt ?? null,
      // Only ever surfaced to the owning user (this route is session-gated
      // above) and only while genuinely live — never serve an expired token.
      connectToken: tokenLive ? row.connectToken : null,
    };
  });

  return NextResponse.json({ integrations });
}

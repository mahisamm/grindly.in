import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { isRateLimited, getIp } from "@/lib/rateLimit";

/**
 * POST /api/track — anonymous first-party pageview beacon for the owner
 * analytics dashboard. No PII: we mint a random `gv` visitor cookie the first
 * time and log { visitorId, path }. Best-effort — a tracking failure must never
 * surface to the visitor, so every path returns 200 (or 204).
 */
const COOKIE = "gv";
const ONE_YEAR = 60 * 60 * 24 * 365;

export async function POST(req: Request) {
  try {
    // Public + unauthenticated by nature — cap per IP so a bot can't flood the
    // page_views table or skew the owner's analytics. 120/min is far above any
    // real browsing rate (one beacon per full page load).
    if (await isRateLimited(`track:${getIp(req)}`, 120, 60_000).catch(() => false)) {
      return new NextResponse(null, { status: 204 });
    }

    const body = (await req.json().catch(() => ({}))) as { path?: string };
    // Normalise: keep the path only, cap length, drop query/hash noise.
    let path = typeof body.path === "string" ? body.path : "/";
    path = path.split("?")[0].split("#")[0].slice(0, 300) || "/";

    const jar = await cookies();
    let visitorId = jar.get(COOKIE)?.value;
    const res = NextResponse.json({ ok: true });
    if (!visitorId) {
      visitorId = randomUUID();
      res.cookies.set(COOKIE, visitorId, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: ONE_YEAR,
        secure: process.env.NODE_ENV === "production",
      });
    }

    // Fire-and-forget insert; swallow if the table isn't migrated yet.
    await prisma.pageView.create({ data: { visitorId, path } }).catch(() => {});
    return res;
  } catch {
    return new NextResponse(null, { status: 204 });
  }
}

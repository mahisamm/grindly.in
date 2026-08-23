import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { report } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VISITOR_COOKIE = "gv";
const MAX_PATH = 200;
// Obvious automation. Not a bot-detection system — just enough that a crawler
// walking the landing page does not read as a hundred visitors.
const BOT = /bot|crawl|spider|slurp|curl|wget|python-requests|headless|lighthouse|pingdom|uptime|monitor/i;

/**
 * The page-view beacon (see components/TrafficBeacon.tsx). One row per
 * navigation: the pathname (never the query string), an anonymous first-party
 * visitor id, and the user id when signed in. No IP, no user agent stored.
 *
 * Always 204, even on a bad body — nothing a visitor does should ever depend
 * on this, and a beacon that errors is noise in the console for no gain.
 */
export async function POST(req: Request) {
  try {
    const ua = req.headers.get("user-agent") ?? "";
    if (BOT.test(ua)) return new NextResponse(null, { status: 204 });

    let path = "";
    try {
      const body = (await req.json()) as { path?: unknown };
      path = typeof body.path === "string" ? body.path : "";
    } catch {
      path = "";
    }
    path = path.split("?")[0].split("#")[0].slice(0, MAX_PATH);
    if (!path.startsWith("/") || path.startsWith("/api/") || path.startsWith("/_next")) {
      return new NextResponse(null, { status: 204 });
    }

    const jar = await cookies();
    let visitorId = jar.get(VISITOR_COOKIE)?.value ?? "";
    const fresh = !/^[a-f0-9]{32}$/.test(visitorId);
    if (fresh) visitorId = crypto.randomBytes(16).toString("hex");

    const userId = await getUid().catch(() => null);
    // The visitor never sees a failure here, but the operator must: a traffic
    // panel that quietly reads zero is worse than one that says why.
    await prisma.pageView
      .create({ data: { path, visitorId, userId } })
      .catch((e) => report({ source: "web", kind: "track-write-failed", message: String(e).slice(0, 400), context: path }));

    const res = new NextResponse(null, { status: 204 });
    if (fresh) {
      res.cookies.set(VISITOR_COOKIE, visitorId, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
      });
    }
    return res;
  } catch {
    return new NextResponse(null, { status: 204 });
  }
}

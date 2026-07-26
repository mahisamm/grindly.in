import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateExtension } from "@/lib/extensionAuth";
import { isRateLimited } from "@/lib/rateLimit";
import { kitEligible } from "@/lib/pipeline";
import { buildKit } from "@/lib/applyKit";

// The kit the extension injects into an application form. Bearer-authed with an
// extension token (NOT the cookie): the request comes from the extension's
// background service worker, which holds the token and never exposes it to the
// third-party page it's filling. Returns only the authenticated user's own data.
//
// CORS: the extension's service worker is a privileged origin (host_permissions
// covers grindly.in in MV3, so the request itself isn't blocked); we still reflect
// the Origin and allow the Authorization header so the response is readable
// regardless of how the extension issues the fetch. Safe to be permissive here
// because auth is a bearer token, not a cookie — there are no ambient credentials
// for another origin to abuse.

function cors(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: cors(req.headers.get("origin")) });
}

/** Compare two job URLs ignoring query/hash/trailing-slash/scheme/case, so a
 *  tracking-param'd tab URL still matches the listing URL we banked. */
function sameListing(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const norm = (u: string) => {
    try {
      const p = new URL(u);
      return (p.host + p.pathname).toLowerCase().replace(/\/+$/, "");
    } catch {
      return u.toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
    }
  };
  return norm(a) === norm(b);
}

export async function GET(req: Request) {
  const headers = cors(req.headers.get("origin"));
  const auth = await authenticateExtension(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });

  // Keyed on the token, not the IP: this is a background service worker making
  // per-page-visit calls, not a browser session — the token is the real identity.
  // 60/5min covers rapid tab-switching across many listings; fail-open on a
  // limiter error so an internal hiccup never blocks a legitimate fill.
  if (await isRateLimited(`ext_kit:${auth.tokenId}`, 60, 5 * 60_000).catch(() => false)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers });
  }

  const url = new URL(req.url).searchParams.get("url");
  if (!url) return NextResponse.json({ error: "url required" }, { status: 400, headers });

  const [user, apps] = await Promise.all([
    prisma.user.findUnique({
      where: { id: auth.userId },
      select: {
        name: true, email: true,
        profile: {
          select: {
            phone: true, gpa: true, education: true, gradYear: true,
            availability: true, workAuthorization: true,
          },
        },
      },
    }),
    // A due "matched" row OR one already approved ("To submit") — never a
    // future-embargoed one. The approved case matters most in practice: it's
    // the exact moment the user clicked "Open & submit" and is about to need
    // the kit, so it must not disappear right when it becomes useful.
    prisma.application.findMany({
      where: { userId: auth.userId, ...kitEligible() },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, jobTitle: true, company: true, url: true, coverLetterText: true, answersJson: true },
    }),
  ]);

  const match = apps.find((a) => sameListing(a.url, url));
  if (!match) {
    // Not an error — the user is just on a page we have no kit for. The extension
    // stays silent rather than nagging on every job page.
    return NextResponse.json({ matched: false }, { headers });
  }

  // Same builder the autopilot claim endpoint uses. Written twice once, and the
  // two copies disagreed on the shape fillEngine reads — see applyKit.ts.
  const kit = buildKit(user ?? { name: "", email: "" }, match);

  return NextResponse.json(
    {
      matched: true,
      applicationId: match.id,
      jobTitle: match.jobTitle,
      company: match.company,
      ...kit,
    },
    { headers },
  );
}

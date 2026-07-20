import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateExtension } from "@/lib/extensionAuth";
import { dueNow } from "@/lib/pipeline";

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

  const url = new URL(req.url).searchParams.get("url");
  if (!url) return NextResponse.json({ error: "url required" }, { status: 400, headers });

  const [user, apps] = await Promise.all([
    prisma.user.findUnique({
      where: { id: auth.userId },
      select: { name: true, email: true, profile: { select: { phone: true, gpa: true } } },
    }),
    // Only due matches — never a future-embargoed one (dueNow mirrors the same
    // visibility gate the dashboard uses; the extension must not surface a listing
    // the user isn't meant to see yet).
    prisma.application.findMany({
      where: { userId: auth.userId, ...dueNow() },
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

  let answers: { q: string; a: string }[] = [];
  try {
    const parsed = JSON.parse(match.answersJson || "[]");
    if (Array.isArray(parsed)) answers = parsed.filter((x) => x && x.q && x.a).map((x) => ({ q: x.q, a: x.a }));
  } catch {
    // malformed → no drafted answers, deterministic profile fills still apply
  }

  return NextResponse.json(
    {
      matched: true,
      applicationId: match.id,
      jobTitle: match.jobTitle,
      company: match.company,
      coverLetter: match.coverLetterText || null,
      answers,
      // Facts the extension fills into name/email/phone/CGPA fields it detects
      // live — so it works even on platforms we couldn't pre-harvest questions from.
      profile: {
        name: user?.name || "",
        email: user?.email || "",
        phone: user?.profile?.phone || "",
        gpa: user?.profile?.gpa ?? null,
      },
    },
    { headers },
  );
}

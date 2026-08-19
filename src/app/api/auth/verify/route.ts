import { NextResponse } from "next/server";
import { isRateLimited, isRateLimitedByIp } from "@/lib/rateLimit";
import { consumeVerification } from "@/lib/emailVerification";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Spend an email verification link.
 *
 * POST, not GET, and the link in the mail points at a page with a button rather
 * than at this route. Mail providers, security appliances and link previewers
 * follow every URL in a message, so a GET that consumes a token is a token
 * consumed before the person has read the sentence next to it — they then click
 * it themselves and are told it has already been used.
 *
 * Unauthenticated: the token IS the authentication, and requiring a session
 * would break the ordinary case of opening the link on a phone.
 */
export async function POST(req: Request) {
  if (await isRateLimitedByIp(req, "verify", 40, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  let body: { token?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Send a JSON body." }, { status: 400 });
  }

  const token = (body.token ?? "").trim();
  if (!token) {
    return NextResponse.json({ error: "That link is incomplete." }, { status: 400 });
  }

  // Keyed on the token itself, like the reset route: the IP limit above does
  // nothing without a trusted proxy, and this is the value being guessed.
  if (await isRateLimited(`verify:tok:${token.slice(0, 64)}`, 10, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  const result = await consumeVerification(token);

  if (!result.ok) {
    if (result.reason === "taken") {
      return NextResponse.json(
        {
          error:
            "Another account has claimed that address since you asked. Your account " +
            "has not changed — sign in and try a different one.",
        },
        { status: 409 },
      );
    }
    if (result.reason === "error") {
      return NextResponse.json({ error: "We could not confirm that address." }, { status: 500 });
    }
    return NextResponse.json(
      { error: "That link has expired or has already been used. Ask for a new one." },
      { status: 400 },
    );
  }

  await audit(result.userId, result.changed ? "email_changed" : "email_verified", result.email);
  return NextResponse.json({ ok: true, email: result.email, changed: result.changed });
}

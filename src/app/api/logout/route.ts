import { NextResponse } from "next/server";
import { baseUrl } from "@/lib/baseUrl";
import { getUid, clearUid, revokeSessions } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sign out, and land the user somewhere.
 *
 * The "Sign out" control is a plain HTML form POST — deliberately, because a
 * sign-out that depends on JavaScript is a sign-out that silently fails on the
 * one session someone most wants ended. But a form POST navigates the browser
 * to whatever this handler returns, and this handler used to return
 * `{"ok":true}`. So signing out worked, and dropped the user on a blank white
 * page showing five characters of JSON, with no header, no link, and no way
 * back except editing the address bar. On a shared or borrowed machine that is
 * the exact moment a person needs to be sure of where they are.
 *
 * 303 rather than 302: it is the status that tells the browser to follow up
 * with a GET. A 302 after a POST is allowed to repeat the POST, and the one
 * thing this route must not do is run twice and bump the token version again
 * for whoever signs in next.
 */
export async function POST(req: Request) {
  // Same-origin only. Without this, any page anywhere can sign a Grindly user
  // out with a hidden auto-submitting form — not a data breach, but a stranger
  // ending your session mid-application is a real thing to prevent, and the
  // check is three lines.
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host) {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host === host;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      return NextResponse.json({ error: "Bad request." }, { status: 403 });
    }
  }

  const uid = await getUid();
  // Bump the user's token version so the cookie we're about to clear (and any
  // copy of it elsewhere) is rejected server-side from now on — logout that
  // actually revokes, not just a client-side cookie delete.
  if (uid) await revokeSessions(uid);
  await clearUid();

  // The PUBLIC base, never `req.url`. Behind Caddy the request Next sees is
  // addressed to the container — req.url is `https://localhost:3000/...` —
  // and the previous `new URL("/", req.url)` sent every signed-out browser on
  // production to https://localhost:3000/, which does not exist. The cookie
  // was cleared and the user was shown a dead page: "sign out does not
  // work", reported live. baseUrl() prefers NEXT_PUBLIC_APP_URL and falls
  // back to the request origin only on a box that has not set it.
  return NextResponse.redirect(`${baseUrl(new URL(req.url).origin)}/`, { status: 303 });
}

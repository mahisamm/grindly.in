import { NextResponse } from "next/server";
import { recordError } from "@/lib/errors";
import { isRateLimitedByIp } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where the browser reports a crash it survived.
 *
 * `global-error.tsx` has been POSTing here since the pivot and this route did
 * not exist, so every root-layout crash — the one failure mode that renders
 * entirely in the browser and leaves no server trace at all — was reported to a
 * 404. We found out about those when someone complained, if they complained.
 *
 * Unauthenticated on purpose. The crash it reports may BE the session: a layout
 * that throws while reading the user is exactly the case this exists for, and a
 * reporter that requires a working session cannot report a broken one.
 *
 * That makes the body attacker-controlled, so:
 *
 *   * it is rate limited per IP, because an open write endpoint is a way to
 *     fill someone's database;
 *   * every field is truncated and stored as data, never interpreted;
 *   * `source` is set here to "browser" rather than read from the request, so
 *     nothing can forge a row that looks like a server-side or agent fault.
 */
export async function POST(req: Request) {
  // Generous, because one broken deploy can legitimately produce a burst from
  // every open tab, and tight enough that a script cannot write all night.
  if (await isRateLimitedByIp(req, "client-error", 30, 10 * 60 * 1000)) {
    // 204, not 429. The caller is an error screen; there is nothing useful it
    // can do with a refusal, and it must not render a second error because the
    // first one could not be reported.
    return new NextResponse(null, { status: 204 });
  }

  let body: { kind?: unknown; message?: unknown; stack?: unknown; path?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  const str = (v: unknown, max: number): string =>
    typeof v === "string" ? v.slice(0, max) : "";

  const message = str(body.message, 1000);
  if (!message) return new NextResponse(null, { status: 204 });

  await recordError({
    source: "browser",
    kind: str(body.kind, 120) || "unhandled",
    message,
    stack: str(body.stack, 4000) || null,
    context: str(body.path, 300) || null,
  });

  return new NextResponse(null, { status: 204 });
}

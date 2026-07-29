import { NextResponse } from "next/server";
import { captureError } from "@/lib/errorLog";
import { getUid } from "@/lib/session";
import { isRateLimited } from "@/lib/rateLimit";

/**
 * Where a crash in the user's BROWSER gets reported.
 *
 * global-error.tsx renders when React has already failed, so nothing about that
 * failure ever reaches the server on its own — the user sees a broken page, and
 * we find out when they say so. This is the one line that closes that gap.
 *
 * Deliberately narrow, because it is a write endpoint reachable by anyone with
 * a session:
 *   * rate limited per user, so a render loop cannot hammer the table;
 *   * fields truncated and fingerprinted by the writer, never trusted for size;
 *   * `source` forced to "browser" — a caller does not get to file a crash as
 *     though the worker raised it.
 */
export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  // A render loop can fire this hundreds of times a second; the report is
  // worth having once, not once per frame.
  if (await isRateLimited(`errors:${uid}`, 20, 60_000)) {
    return NextResponse.json({ ok: true, throttled: true });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const message = String(body.message ?? "").trim();
  if (!message) return NextResponse.json({ error: "no message" }, { status: 400 });

  await captureError({
    source: "browser",
    kind: String(body.kind ?? "unhandled"),
    message,
    stack: String(body.stack ?? ""),
    // The path is what makes a browser crash actionable; the body of whatever
    // the page was doing is not ours to store.
    context: { uid, path: String(body.path ?? "") },
  });
  return NextResponse.json({ ok: true });
}

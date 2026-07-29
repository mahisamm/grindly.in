import { createHash } from "crypto";
import { prisma } from "./prisma";

/**
 * Crashes, recorded where an operator can see them — the web half of
 * agent/error_log.py, writing to the same table with the same fingerprint rule
 * so a fault that happens on both sides groups as one row.
 *
 * Sentry has been wired since the beginning and never switched on, because
 * switching it on needs an account on someone else's service. This needs
 * nobody's signup and no DNS.
 *
 * Every function here is best-effort by construction: an error logger that
 * throws turns a handled failure into an outage.
 */

const MAX_STACK = 4000;
const MAX_MESSAGE = 500;

/** What makes two crashes "the same bug". Must match agent/error_log.fingerprint. */
export function fingerprint(source: string, kind: string, message: string): string {
  return createHash("sha1").update(`${source}\n${kind}\n${message}`).digest("hex");
}

function clean(text: string, limit: number): string {
  return (text || "").trim().replaceAll("\0", "").slice(0, limit);
}

export type CaptureInput = {
  source?: "web" | "browser";
  kind?: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
};

export async function captureError(input: CaptureInput): Promise<void> {
  try {
    const source = input.source ?? "web";
    const kind = clean(input.kind || "unhandled", 120);
    const message = clean(input.message, MAX_MESSAGE) || kind;
    const stack = clean(input.stack || "", MAX_STACK);
    let context = "";
    if (input.context) {
      try {
        context = clean(JSON.stringify(input.context), 2000);
      } catch {
        context = "";
      }
    }
    const fp = fingerprint(source, kind, message);

    await prisma.errorEvent.upsert({
      where: { fingerprint: fp },
      create: { fingerprint: fp, source, kind, message, stack, context },
      update: {
        count: { increment: 1 },
        lastSeenAt: new Date(),
        stack,
        context,
        // A bug that comes back was not fixed. Clearing this is what makes
        // "new since I last looked" mean anything.
        resolvedAt: null,
      },
    });
  } catch (e) {
    // Already in the failure path; throwing here would replace a handled error
    // with an unhandled one.
    console.error("[errorLog] could not record a failure:", e);
  }
}

/** Wrap a route handler so a throw is recorded before it becomes a 500. */
export async function recordingErrors<T>(
  where: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const err = e as Error;
    await captureError({
      kind: err?.name || "Error",
      message: err?.message || String(e),
      stack: err?.stack,
      context: { where },
    });
    throw e;
  }
}

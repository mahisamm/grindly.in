import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { computeReadiness } from "@/lib/readiness";

// GET /api/autopilot — one honest answer to "what is my agent doing?".
//
// Every number here is derived from what actually happened, never from
// optimistic UI state. The distinction the whole panel is built around:
// SUBMITTED means an application reached an employer. Queued, prepared and
// needs-action are counted separately and never folded into that number,
// because a dashboard that inflates "applied" is lying to someone about their
// own job search.
export const dynamic = "force-dynamic";

/** The user's local calendar date — the cap is "N per their day", not per UTC day. */
function localDate(timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "Asia/Kolkata",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
  } catch {
    // An unknown zone must not break the panel.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
  }
}

export async function GET() {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: {
      name: true, email: true,
      profile: {
        select: {
          resumeName: true, phone: true, education: true, gradYear: true,
          preferredDomains: true, autoApply: true, autoApplyConsentAt: true,
          consentVersion: true, maxPerDay: true, timezone: true,
        },
      },
    },
  });
  if (!user) return NextResponse.json({ error: "not found" }, { status: 404 });

  const tz = user.profile?.timezone || "Asia/Kolkata";
  const cap = user.profile?.maxPerDay ?? 0;
  const readiness = computeReadiness(user);

  const [usage, queued, lifetime, recent, blocked, browser] = await Promise.all([
    // The reservation ledger the worker writes — the same source that enforces
    // the cap, so the number shown can never disagree with the number applied.
    prisma.dailyUsage
      .findUnique({ where: { userId_localDate: { userId: uid, localDate: localDate(tz) } } })
      .catch(() => null),
    prisma.application.count({ where: { userId: uid, status: "matched" } }).catch(() => 0),
    prisma.application
      .count({ where: { userId: uid, status: { in: ["applied", "needs_review"] } } })
      .catch(() => 0),
    // The timeline: what the agent actually did, most recent first.
    prisma.application
      .findMany({
        where: { userId: uid, status: { in: ["applied", "needs_review", "failed"] } },
        orderBy: [{ appliedAt: "desc" }, { createdAt: "desc" }],
        take: 20,
        select: {
          id: true, jobTitle: true, company: true, url: true, status: true,
          appliedAt: true, applyChannel: true, applyTier: true, reason: true,
        },
      })
      .catch(() => []),
    // Tasks stopped at a human gate. These are the ONLY thing on this panel the
    // user must act on, so they are fetched separately rather than mixed into
    // the timeline, where they would read as history instead of a request.
    prisma.browserTask
      .findMany({
        where: { userId: uid, state: "awaiting_human" },
        orderBy: { updatedAt: "desc" },
        take: 10,
        select: { id: true, url: true, host: true, blockedReason: true, updatedAt: true },
      })
      .catch(() => []),
    // Is a browser actually connected to do that work? An action-needed list
    // with no paired browser is a dead end, so the UI needs to know.
    prisma.extensionToken
      .findFirst({
        where: { userId: uid, revokedAt: null },
        orderBy: { lastUsedAt: "desc" },
        select: { label: true, lastUsedAt: true },
      })
      .catch(() => null),
  ]);

  const submittedToday = usage?.submitted ?? 0;

  return NextResponse.json({
    // paused | setup_incomplete | active — one word the UI can render directly
    // rather than re-deriving the same logic a third time.
    state: !readiness.checks.consent
      ? "paused"
      : readiness.ready
        ? "active"
        : "setup_incomplete",
    readiness,
    today: {
      submitted: submittedToday,
      limit: cap,
      remaining: Math.max(0, cap - submittedToday),
      // Reservations taken, including ones released after a definite non-send.
      // Kept separate from `submitted` so a retry-heavy day never reads as more
      // applications than the employer actually received.
      attempted: usage?.attempted ?? 0,
      date: localDate(tz),
      timezone: tz,
    },
    queued,
    lifetimeSubmitted: lifetime,
    timeline: recent,
    // Plain-English reasons: the user is being asked to do something, so the
    // ask has to be legible without knowing our vocabulary.
    actionNeeded: blocked.map((t) => ({
      id: t.id,
      url: t.url,
      host: t.host,
      reason: t.blockedReason,
      says: {
        captcha: "This site asked for a CAPTCHA — open it and clear the check.",
        otp: "This site sent a one-time code. Enter it and Grindly will carry on.",
        login: "You need to sign in on this site first.",
        payment: "This site is asking for a payment. Grindly will never pay to apply.",
        unknown_question: "There's a question only you can answer honestly.",
        changed_form: "Grindly sent this but the site never confirmed — please check it.",
      }[t.blockedReason ?? ""] ?? "This one needs a look from you.",
      at: t.updatedAt,
    })),
    browser: browser
      ? { connected: true, label: browser.label, lastSeen: browser.lastUsedAt }
      : { connected: false },
  });
}

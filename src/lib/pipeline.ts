// What the user is allowed to see of their match pipeline.
//
// A discovery sweep banks roughly a month of matches at once (plan cap x 30, see
// agent/worker.py:PIPELINE_DAYS). The user must never be shown that whole pile:
// a list of 300 live job URLs is the product, and handing it over in one screen
// invites them to close the tab and go apply by hand. It is also a terrible idea
// operationally — a user who could approve 300 at once would mass-apply, which is
// the loudest bot signal there is.
//
// So each match carries a `scheduledFor` date, and only the ones that have come
// due are ever serialized to the client. Everything else is a COUNT, not a list.
//
// This is a server-side gate, not a UI convenience. Both /api/me and
// /api/applications import from here precisely so they cannot drift apart and
// quietly open a hole. Mirrors agent/db.py:ready_today_count().

import type { Prisma } from "@prisma/client";

/** Matches that have come due: scheduled for now-or-earlier, or unscheduled
 *  (null = due immediately — legacy rows, and anything a human queued by hand). */
export function dueNow(now: Date = new Date()): Prisma.ApplicationWhereInput {
  return {
    status: "matched",
    OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }],
  };
}

/** The full visibility rule for a user's application list: everything that is
 *  NOT a still-embargoed future match. Applied/failed/skipped history is all
 *  visible — it's the un-due matches, and only those, that stay hidden. */
export function visibleToUser(
  userId: string,
  now: Date = new Date(),
): Prisma.ApplicationWhereInput {
  return {
    userId,
    OR: [
      { status: { not: "matched" } },
      { scheduledFor: null },
      { scheduledFor: { lte: now } },
    ],
  };
}

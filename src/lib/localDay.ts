// The user's calendar day, not the server's. Every "today" number shown to a
// user (sent today, left today, approvals pending) must share ONE day boundary:
// midnight in the user's own timezone. The web containers run UTC, so a
// server-local or UTC midnight is 5.5 hours into an Indian user's day and
// silently drops everything an overnight agent run sent before 05:30.
//
// agent/db.py user_local_date() is the Python mirror of localDate(); if the
// fallback zone changes here it must change there too.

/** The user's local calendar date as YYYY-MM-DD. */
export function localDate(timezone: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "Asia/Kolkata",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(now);
  } catch {
    // An unknown zone must not break a dashboard read.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(now);
  }
}

/** Midnight in the user's own zone, as an instant. */
export function startOfLocalDay(timezone: string, now = new Date()): Date {
  const tz = timezone || "Asia/Kolkata";
  try {
    const offset =
      new Date(now.toLocaleString("en-US", { timeZone: tz })).getTime() -
      new Date(now.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
    return new Date(Date.parse(`${localDate(tz, now)}T00:00:00Z`) - offset);
  } catch {
    return new Date(Date.parse(`${localDate(tz)}T00:00:00Z`));
  }
}

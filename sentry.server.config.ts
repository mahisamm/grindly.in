import * as Sentry from "@sentry/nextjs";
import { recordError, describeThrown } from "@/lib/errors";

// Optional — only activates when SENTRY_DSN is set. Without a build-time
// SENTRY_AUTH_TOKEN / SENTRY_ORG / SENTRY_PROJECT, stack traces won't be
// de-minified, but error capture still works.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.05,
    // Mirror anything Sentry captures into our own error table.
    //
    // Not redundancy for its own sake: Sentry is optional here and unset on
    // most deployments, and the admin page is the only view an operator has
    // without one. This is also the path that catches faults nobody wrote a
    // try/catch for — an unhandled rejection reaches Sentry and would otherwise
    // reach nothing of ours at all.
    //
    // Returns the event untouched. A hook that can change what Sentry sends is
    // a hook that can lose an error report.
    beforeSend(event, hint) {
      try {
        const thrown = hint?.originalException;
        const described = thrown ? describeThrown(thrown) : null;
        void recordError({
          source: "web",
          kind: described?.kind ?? event.exception?.values?.[0]?.type ?? "unhandled",
          message:
            described?.message ??
            event.exception?.values?.[0]?.value ??
            event.message ??
            "(no message)",
          stack: described?.stack ?? null,
          context: event.transaction ?? null,
        });
      } catch {
        /* a reporting hook must never be the thing that swallows a report */
      }
      return event;
    },
  });
}

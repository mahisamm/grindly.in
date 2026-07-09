import * as Sentry from "@sentry/nextjs";

// Optional — only activates when SENTRY_DSN is set (same gate the Python
// worker uses in agent/worker.py). Without a build-time SENTRY_AUTH_TOKEN /
// SENTRY_ORG / SENTRY_PROJECT, stack traces won't be de-minified, but error
// capture still works.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.05,
  });
}

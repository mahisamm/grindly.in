import * as Sentry from "@sentry/nextjs";

// Optional — only activates when SENTRY_DSN is set. Covers proxy.ts / any
// edge-runtime code (the Node server path is initialized in
// sentry.server.config.ts instead).
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.05,
  });
}

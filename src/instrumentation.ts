// Runs once when the Node server boots (Next `register` hook). Audits external
// service wiring and logs a LOUD warning for anything required-but-missing in
// production — so a missing SMS/SMTP key is caught at deploy time in the logs,
// not as a user-facing crash on the first login attempt. Never throws: a bad
// config should surface clearly, not brick the whole server.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");

    const { serviceStatus, missingProdConfig } = await import("@/lib/serverConfig");
    console.log("[startup] service config:", JSON.stringify(serviceStatus()));

    if (process.env.NODE_ENV === "production") {
      const missing = missingProdConfig();
      if (missing.length) {
        console.warn("[startup] ⚠ MISSING PRODUCTION CONFIG — the app will be degraded/broken until these are set:");
        for (const m of missing) console.warn(`   - ${m}`);
      } else {
        console.log("[startup] ✓ all required production services configured");
      }

      const { startWorkerWatchdog } = await import("@/lib/workerWatchdog");
      startWorkerWatchdog();
    }
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

// Reports server-side render/route/action errors to Sentry (no-ops if
// SENTRY_DSN isn't set, since Sentry.init above never ran). Previously these
// only reached console.error/stdout — invisible unless someone was tailing
// docker logs at the right moment.
export async function onRequestError(...args: Parameters<typeof import("@sentry/nextjs").captureRequestError>) {
  if (!process.env.SENTRY_DSN) return;
  const Sentry = await import("@sentry/nextjs");
  Sentry.captureRequestError(...args);
}

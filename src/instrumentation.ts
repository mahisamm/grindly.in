// Runs once when the Node server boots (Next `register` hook). Audits external
// service wiring and logs a LOUD warning for anything required-but-missing in
// production — so a missing SMS/SMTP key is caught at deploy time in the logs,
// not as a user-facing crash on the first login attempt. Never throws: a bad
// config should surface clearly, not brick the whole server.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");

    const { serviceStatus, missingProdConfig, missingBetaAutomationConfig, encryptionKeyValid, googleOAuthConfigured, baseUrlConfigured } = await import("@/lib/serverConfig");
    console.log("[startup] service config:", JSON.stringify(serviceStatus()));

    if (process.env.NODE_ENV === "production") {
      // Hard stop: without a valid 64-hex APP_ENCRYPTION_KEY the session HMAC is
      // computed with an empty secret, so anyone can forge a login for any user.
      // Refuse to boot rather than merely warn — a crash-on-start is far better
      // than silent auth bypass.
      if (!encryptionKeyValid()) {
        throw new Error(
          "[startup] FATAL: APP_ENCRYPTION_KEY missing or not 64 hex chars. " +
            "Refusing to start in production — sessions would be forgeable. Run `npm run setup`."
        );
      }

      // Google OAuth is the ONLY door into the app and the redirect_uri is built
      // from NEXT_PUBLIC_APP_URL. If either is missing the server still boots and
      // /api/health still passes, yet every login either 500s (no client) or dies
      // with redirect_uri_mismatch (redirect falls back to localhost) — an invisible
      // outage where nobody can sign in. Fail fast so a misconfigured deploy refuses
      // to boot instead of booting a login-dead app.
      if (!googleOAuthConfigured()) {
        throw new Error(
          "[startup] FATAL: GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET missing. " +
            "Google is the only login method — refusing to start with no way in."
        );
      }
      if (!baseUrlConfigured()) {
        throw new Error(
          "[startup] FATAL: NEXT_PUBLIC_APP_URL (or NEXT_PUBLIC_BASE_URL) missing. " +
            "The OAuth redirect_uri would fall back to http://localhost:3000 and every " +
            "Google login would fail with redirect_uri_mismatch. Set it to your public origin."
        );
      }

      const missing = missingProdConfig();
      if (missing.length) {
        console.warn("[startup] ⚠ MISSING PRODUCTION CONFIG — the app will be degraded/broken until these are set:");
        for (const m of missing) console.warn(`   - ${m}`);
      } else {
        console.log("[startup] ✓ all required production services configured");
      }

      const betaMissing = missingBetaAutomationConfig();
      if (betaMissing.length) {
        const detail = betaMissing.join(", ");
        if (process.env.BETA_ENFORCE_READINESS === "1") {
          throw new Error(`[startup] FATAL: beta readiness is enforced but missing: ${detail}`);
        }
        console.warn(`[startup] beta automation is degraded: ${detail}`);
      } else {
        console.log("[startup] ✓ full beta automation contract configured");
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

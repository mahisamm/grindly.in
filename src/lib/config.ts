/**
 * Server configuration, read once and reported honestly.
 *
 * The value of this file is `describe()`: a single place that says what this
 * deployment can actually do. `/api/health` returns it and the preflight script
 * prints it, so "why isn't Google sign-in showing up" has an answer that does
 * not involve reading source.
 *
 * The rule everything here follows: a capability is OFF unless its
 * configuration is complete. Half-configured is off, not on-and-broken. The
 * previous build had a payments path that went live the moment a Razorpay key
 * appeared in the environment — including in staging, and during a key rotation
 * — which is why `paymentsEnabled` is its own explicit switch rather than being
 * inferred from the keys being present.
 */

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

function truthy(name: string): boolean {
  return ["1", "true", "yes", "on"].includes(env(name).toLowerCase());
}

export const isProd = process.env.NODE_ENV === "production";

export function googleOAuthConfigured(): boolean {
  return Boolean(env("GOOGLE_CLIENT_ID") && env("GOOGLE_CLIENT_SECRET"));
}

export function smtpConfigured(): boolean {
  return Boolean(env("EMAIL_SMTP_HOST") && env("EMAIL_SMTP_USER") && env("EMAIL_SMTP_PASS"));
}

/**
 * Payments are on ONLY when this is explicitly "true" AND both keys exist.
 *
 * Both halves are load-bearing. The switch alone would let a misconfigured box
 * take money it cannot verify; the keys alone would turn on real checkout in
 * every environment that happens to have them.
 */
export function paymentsEnabled(): boolean {
  return (
    env("PAYMENTS_ENABLED").toLowerCase() === "true" &&
    Boolean(env("RAZORPAY_KEY_ID") && env("RAZORPAY_KEY_SECRET"))
  );
}

export function llmProviders(): string[] {
  return (
    [
      ["GROQ_API_KEY", "groq"],
      ["GEMINI_API_KEY", "gemini"],
      ["CEREBRAS_API_KEY", "cerebras"],
      ["MISTRAL_API_KEY", "mistral"],
      // The optional paid fallback (agent/llm.py). It belongs in this list for
      // one specific reason: a deployment configured with ONLY this key is
      // fully able to rewrite, and without the entry the admin page and the
      // health check would both report "disabled (no LLM key)" on a box that
      // works.
      ["ANTHROPIC_API_KEY", "anthropic (paid)"],
    ] as const
  )
    .filter(([key]) => env(key))
    .map(([, name]) => name);
}

export function encryptionKeyValid(): boolean {
  return /^[0-9a-fA-F]{64}$/.test(env("APP_ENCRYPTION_KEY"));
}

export function appUrl(): string {
  return env("NEXT_PUBLIC_APP_URL") || "http://localhost:3000";
}

export function adminEmail(): string {
  return env("ADMIN_EMAIL").toLowerCase();
}

export type ServerCapabilities = {
  env: string;
  auth: { password: true; google: boolean };
  payments: { enabled: boolean; provider: "razorpay" | "stub" };
  email: "smtp" | "outbox";
  llmProviders: string[];
  /** Empty when the deployment is complete. Non-empty is the whole diagnosis. */
  missing: string[];
};

export function describe(): ServerCapabilities {
  const missing: string[] = [];
  if (!encryptionKeyValid()) missing.push("APP_ENCRYPTION_KEY (64 hex chars)");
  if (!env("DATABASE_URL")) missing.push("DATABASE_URL");
  if (isProd && !smtpConfigured()) missing.push("EMAIL_SMTP_HOST/USER/PASS");
  if (isProd && !env("NEXT_PUBLIC_APP_URL")) missing.push("NEXT_PUBLIC_APP_URL");
  // Not "missing" in production terms — the product works without a model, on
  // the deterministic scorer alone — but it is the difference between a full
  // rewrite feature and a report, so it is worth naming.
  if (llmProviders().length === 0) missing.push("an LLM key (rewrites are disabled without one)");

  return {
    env: process.env.NODE_ENV ?? "development",
    auth: { password: true, google: googleOAuthConfigured() },
    payments: {
      enabled: paymentsEnabled(),
      provider: paymentsEnabled() ? "razorpay" : "stub",
    },
    email: smtpConfigured() ? "smtp" : "outbox",
    llmProviders: llmProviders(),
    missing,
  };
}

/**
 * Refuse to boot a production deployment with development defaults.
 *
 * Called from instrumentation. The failure mode this prevents is the worst kind
 * of quiet: a real deployment running with a well-known secret key, where every
 * session cookie in the world can be forged and nothing looks wrong.
 */
export function assertProdSafe(): void {
  if (!isProd) return;
  const problems: string[] = [];
  if (!encryptionKeyValid()) {
    problems.push("APP_ENCRYPTION_KEY must be 64 hex characters");
  }
  if (env("APP_ENCRYPTION_KEY") === "0".repeat(64)) {
    problems.push("APP_ENCRYPTION_KEY is a placeholder value");
  }
  if (!env("DATABASE_URL")) problems.push("DATABASE_URL is not set");
  if (env("DATABASE_URL").includes("change_me")) {
    problems.push("DATABASE_URL still contains the example password");
  }
  if (problems.length) {
    throw new Error(
      `Refusing to start in production:\n  - ${problems.join("\n  - ")}\n` +
        "Fix these in the environment, not in code.",
    );
  }
}

export { truthy, env };

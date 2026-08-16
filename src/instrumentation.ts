/**
 * Runs once per server process, before the first request.
 *
 * Its only job is to refuse to start a production deployment that is
 * misconfigured in a way nobody would notice at runtime — a placeholder
 * encryption key being the one that matters, because every session cookie in
 * the world would then be forgeable and absolutely nothing would look wrong.
 */
import { assertProdSafe, describe } from "@/lib/config";

export async function register() {
  // Only the Node runtime has process.env fully and can throw usefully; the
  // edge runtime imports this file too.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  assertProdSafe();

  const caps = describe();
  console.log(
    "[startup]",
    JSON.stringify({
      env: caps.env,
      auth: caps.auth,
      payments: caps.payments.provider,
      email: caps.email,
      llm: caps.llmProviders,
      missing: caps.missing,
    }),
  );
}

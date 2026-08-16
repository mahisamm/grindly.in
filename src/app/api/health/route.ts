import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { describe } from "@/lib/config";
import { runAgent } from "@/lib/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Is this deployment actually able to do its job?
 *
 * Deliberately checks the two things that are invisible until a user hits them:
 * that Postgres answers, and that the Python side can render a PDF. A health
 * check that only reports "the web process is up" is the one that stays green
 * through an outage — the previous build's did exactly that while every rewrite
 * failed for want of a compiler.
 *
 * `?deep=1` runs the Python probe, which spawns an interpreter and costs about a
 * second. The default is cheap enough for a container healthcheck on a 15s loop.
 */
export async function GET(req: Request) {
  const deep = new URL(req.url).searchParams.get("deep") === "1";
  const caps = describe();

  let database = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    database = true;
  } catch (e) {
    console.error("[health] database unreachable:", e);
  }

  const checks: Record<string, unknown> = {
    database,
    encryptionKey: caps.missing.every((m) => !m.startsWith("APP_ENCRYPTION_KEY")),
    payments: caps.payments.provider,
    email: caps.email,
    googleAuth: caps.auth.google,
    llmProviders: caps.llmProviders,
  };

  if (deep) {
    const probe = await runAgent<{ checks: Record<string, unknown> }>("health");
    checks.agent = probe.ok ? probe.checks : { error: probe.error };
  }

  // `ok` is about serving requests correctly, not about being fully configured.
  // A deployment with no LLM key still scores resumes, so it is healthy; it just
  // cannot rewrite. Conflating the two makes the healthcheck flap on config.
  const ok = database && checks.encryptionKey === true;
  return NextResponse.json(
    { ok, env: caps.env, checks, missing: caps.missing },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { serviceStatus, missingProdConfig, encryptionKeyValid } from "@/lib/serverConfig";
import { getAdminOrNull } from "@/lib/admin";

/**
 * GET /api/health — readiness probe for deploys + manual checks.
 *
 * `ok` is liveness (DB reachable + encryption key valid) and stays public,
 * because that is what a probe and an uptime monitor actually need.
 *
 * The diagnostic half — `services`, `missing`, `prodReady` — is admin-only.
 * It never contained a secret VALUE, but naming which secret is missing is
 * itself a map for an attacker: `missingProdConfig()` will happily tell an
 * anonymous caller "APP_ENCRYPTION_KEY (64 hex) — platform connect throws",
 * i.e. that the key protecting stored Internshala and Gmail credentials is
 * absent or malformed, and which integrations are unwired.
 */
export async function GET() {
  const checks: Record<string, boolean> = {};
  checks.encryptionKey = encryptionKeyValid();

  try {
    await prisma.user.count();
    checks.database = true;
  } catch {
    checks.database = false;
  }

  const ok = checks.encryptionKey && checks.database;
  const status = ok ? 200 : 503;

  const admin = await getAdminOrNull();
  if (!admin) return NextResponse.json({ ok, checks }, { status });

  const missing = missingProdConfig();
  return NextResponse.json(
    { ok, checks, services: serviceStatus(), prodReady: ok && missing.length === 0, missing },
    { status },
  );
}

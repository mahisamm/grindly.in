import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export const REQUIRED_DATABASE_TABLES = [
  "users",
  "user_integrations",
  "profiles",
  "resume_variants",
  "jobs",
  "company_reputation",
  "applications",
  "resume_versions",
  "audit_logs",
  "support_tickets",
  "agent_runs",
  "platform_credentials",
  "notifications",
  "extension_tokens",
  "reports",
  "otp_tokens",
  "otp_attempts",
  "password_reset_tokens",
  "rate_limit_entries",
  "backup_health",
  "access_allowlist",
  "page_views",
] as const;

/** Confirm that the database is reachable and has every table this build needs. */
export async function databaseSchemaReady(): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ table_name: string }>>(
    Prisma.sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (${Prisma.join(REQUIRED_DATABASE_TABLES)})
    `,
  );

  const present = new Set(rows.map((row) => row.table_name));
  return REQUIRED_DATABASE_TABLES.every((table) => present.has(table));
}

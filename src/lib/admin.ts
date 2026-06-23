// Admin access guard. The ONLY source of truth for admin authorization is the
// User.role column — never an email allowlist, never a client-sent flag.
//
// Two helpers:
//   requireAdmin()      — for API routes. Returns the admin user or a 404 Response.
//   getAdminOrNull()    — for server pages/layouts. Returns the admin user or null.
//
// Why 404 and not 403: an unauthorized caller should not even learn that the
// admin surface exists. Every admin route/page returns the same not-found shape
// it would for any other missing path.
import { NextResponse } from "next/server";
import { prisma } from "./prisma";
import { getUid } from "./session";
import { audit } from "./audit";

export type AdminUser = { id: string; email: string; name: string | null; role: string };

async function loadAdmin(): Promise<AdminUser | null> {
  const uid = await getUid();
  if (!uid) return null;
  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: { id: true, email: true, name: true, role: true },
  });
  if (!user || user.role !== "admin") return null;
  return user;
}

/**
 * For API route handlers. On success returns { admin }. On failure returns
 * { error: Response } — a 404 indistinguishable from a missing route. Callers
 * must `if ("error" in g) return g.error;` before using `g.admin`.
 */
export async function requireAdmin(): Promise<{ admin: AdminUser } | { error: NextResponse }> {
  const admin = await loadAdmin();
  if (!admin) {
    return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  return { admin };
}

/** For server components / layouts. Returns the admin user, or null to 404. */
export async function getAdminOrNull(): Promise<AdminUser | null> {
  return loadAdmin();
}

/** Record an admin action in the append-only audit trail. */
export async function adminAudit(
  admin: AdminUser,
  action: string,
  target?: string | null,
  detail?: string | null
): Promise<void> {
  await audit(`admin_${action}`, { userId: admin.id, target: target ?? null, detail: detail ?? null });
}

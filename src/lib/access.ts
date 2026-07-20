// Approval-gated beta access. The single source of truth for "can this account
// use the app" — the dashboard, onboarding, and every agent/apply mutation gate
// on this, so a pending user can sign in and set preferences but cannot make the
// agent do anything until an admin approves their email.
//
// Access is orthogonal to admin authority (lib/admin.ts). The owner is always
// granted access; a normal approved user has access but no admin surface.
import { NextResponse } from "next/server";
import { prisma } from "./prisma";
import { getUid } from "./session";
import { readAdminSettings } from "./adminSettings";

export type AccessStatus = "pending" | "approved" | "denied";

const OWNER_EMAIL = process.env.ADMIN_EMAIL;

type AccessFields = { accessStatus: string; role: string; email: string };

/** Pure predicate — true if this account may use the app. */
export function hasAppAccess(u: AccessFields): boolean {
  if (u.role === "admin") return true;
  if (OWNER_EMAIL && u.email === OWNER_EMAIL) return true;
  return u.accessStatus === "approved";
}

/**
 * Decide a brand-new account's access at signup time. The owner and any email an
 * admin pre-allowlisted come in already approved. While `openSignups` is on
 * (the default — toggle from /admin/settings), everyone else comes in
 * approved too; when it's off, this falls back to the allowlist/queue.
 */
export async function resolveInitialAccess(email: string): Promise<AccessStatus> {
  if (OWNER_EMAIL && email === OWNER_EMAIL) return "approved";
  if (readAdminSettings().openSignups) return "approved";
  try {
    // Allowlist is stored lowercased; match case-insensitively so a grant added
    // as "Foo@x.com" still clears a signup that arrives as "foo@x.com".
    const allowed = await prisma.accessAllowlist.findUnique({ where: { email: email.toLowerCase() } });
    if (allowed) return "approved";
  } catch {
    // Allowlist table may not be migrated yet — fail closed to "pending".
  }
  return "pending";
}

/**
 * Guard for mutating routes (agent run, approve, activate…). On success returns
 * { uid }. On failure returns { error } — 401 if unauthenticated, 403 with a
 * machine `code` the client uses to route the user to the waitlist.
 */
export async function requireAccess(): Promise<
  { uid: string } | { error: NextResponse }
> {
  const uid = await getUid();
  if (!uid) {
    return { error: NextResponse.json({ error: "no session" }, { status: 401 }) };
  }
  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: { accessStatus: true, role: true, email: true },
  });
  if (!user) {
    return { error: NextResponse.json({ error: "not found" }, { status: 404 }) };
  }
  if (!hasAppAccess(user)) {
    return {
      error: NextResponse.json(
        { error: "Your access is pending approval.", code: "access_pending" },
        { status: 403 },
      ),
    };
  }
  return { uid };
}

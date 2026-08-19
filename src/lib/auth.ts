/**
 * One place that answers "who is calling, and may they?".
 *
 * Every protected route starts with `requireUser()`. Returning a discriminated
 * union rather than throwing means the caller writes
 *
 *     const auth = await requireUser();
 *     if ("error" in auth) return auth.error;
 *
 * which TypeScript enforces — there is no path where `auth.user` is reachable
 * without the check having run. A `throw`-based helper compiles fine when
 * someone forgets the try/catch, and the route ships unauthenticated.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { report } from "@/lib/errors";

export type SessionUser = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  plan: string;
  planExpiresAt: Date | null;
  createdAt: Date;
  /** pending | approved | blocked — the closed-beta door. See `isApproved`. */
  accessStatus: string;
  /** The resume they are actually sending out. May be stale — see lib/primary. */
  primaryResumeId: string | null;
};

export type AuthOk = { user: SessionUser };
export type AuthErr = { error: NextResponse };

const SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  plan: true,
  planExpiresAt: true,
  createdAt: true,
  accessStatus: true,
  primaryResumeId: true,
  deletedAt: true,
} as const;

/** The signed-in user, or null. Never throws. */
export async function currentUser(): Promise<SessionUser | null> {
  const uid = await getUid();
  if (!uid) return null;
  const user = await prisma.user.findUnique({ where: { id: uid }, select: SELECT }).catch(() => null);
  // A soft-deleted account keeps its rows for the deletion grace period but must
  // not be able to sign in with a cookie issued before the delete.
  if (!user || user.deletedAt) return null;
  // deletedAt is destructured away rather than passed on: this function has
  // already acted on it, and handing callers a flag they might check again is
  // how two different answers to "is this account deleted" end up in one
  // codebase.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { deletedAt: _deletedAt, ...rest } = user;
  return rest;
}

/**
 * May this account use the product?
 *
 * ADMINS ALWAYS CAN, whatever their row says. That is not a convenience: the
 * approval queue lives behind the admin surface, so an admin who could be left
 * `pending` would be locked out of the only screen that could let them in.
 * The one account that must never be gated is the one holding the key.
 */
export function isApproved(user: { role?: string | null; accessStatus?: string | null }): boolean {
  if (user.role === "admin") return true;
  return user.accessStatus === "approved";
}

export async function requireUser(): Promise<AuthOk | AuthErr> {
  const user = await currentUser();
  if (!user) {
    return {
      error: NextResponse.json({ error: "Sign in to continue." }, { status: 401 }),
    };
  }
  return { user };
}

/**
 * A signed-in user who has been let into the beta.
 *
 * Used by every route that DOES something — uploads, rebuilds, exports. Reading
 * your own account is deliberately not gated: someone waiting for approval
 * should still be able to see their settings page and delete the account they
 * just made.
 *
 * 403 with a code rather than 401, because the session is perfectly valid and
 * signing in again would achieve nothing. The client uses the code to send them
 * to the waiting screen instead of the sign-in page.
 */
export async function requireApprovedUser(): Promise<AuthOk | AuthErr> {
  const auth = await requireUser();
  if ("error" in auth) return auth;
  if (!isApproved(auth.user)) {
    return {
      error: NextResponse.json(
        {
          error:
            "Your account is waiting to be let into the beta. You will be able to use " +
            "Grindly as soon as it is approved.",
          code: "pending_approval",
        },
        { status: 403 },
      ),
    };
  }
  return auth;
}

export async function requireAdmin(): Promise<AuthOk | AuthErr> {
  const auth = await requireUser();
  if ("error" in auth) return auth;
  if (auth.user.role !== "admin") {
    // 404, not 403: an admin surface should not confirm its own existence to a
    // signed-in stranger probing for it.
    return { error: NextResponse.json({ error: "Not found." }, { status: 404 }) };
  }
  return auth;
}

/**
 * Ownership check for a resource that hangs off a user.
 *
 * Always compares against the session's user id and always answers 404 for
 * "someone else's" — a 403 tells the caller the id exists, which is how an
 * enumeration turns into a list of every resume id on the instance.
 */
export function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

export function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * A 500, recorded.
 *
 * Every route in the app answers a fault by calling this, which made it the one
 * place worth teaching to write the fault down. Before this, a 500 existed only
 * as a line in a container log and as a sentence on someone's screen, and the
 * admin page's error table — the operator's whole view of what is broken — sat
 * empty through every outage.
 *
 * `context` is what makes a row actionable: the route, and anything the caller
 * knows about which record it was working on.
 */
export function serverError(
  message = "Something went wrong on our side.",
  context?: string,
): NextResponse {
  report({ source: "web", kind: "server-error", message, context: context ?? null });
  return NextResponse.json({ error: message }, { status: 500 });
}

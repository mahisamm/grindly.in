// Append-only audit trail. Best-effort: a failed audit write must never block
// the action it records.
//
// Positional signature, because every call site passes the user and the target
// and the options-object form made the common case read as
// `audit("login", {userId: id, target: email})` — three quarters punctuation.
import { prisma } from "./prisma";

export async function audit(
  userId: string | null,
  action: string,
  target?: string | null,
  detail?: string | null,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action,
        userId: userId ?? null,
        target: target ?? null,
        // Truncated here rather than at every call site. An audit row that
        // records a 60 KB error body is a log, not an audit trail.
        detail: detail ? String(detail).slice(0, 1000) : null,
      },
    });
  } catch (e) {
    console.error("[audit] write failed:", (e as Error).message);
  }
}

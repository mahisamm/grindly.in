// Append-only audit trail. Best-effort: a failed audit write must never block
// the action it records (auth, apply, etc).
import { prisma } from "./prisma";

export async function audit(
  action: string,
  opts?: { userId?: string | null; target?: string | null; detail?: string | null }
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action,
        userId: opts?.userId ?? null,
        target: opts?.target ?? null,
        detail: opts?.detail ?? null,
      },
    });
  } catch (e) {
    console.error("[audit] write failed:", (e as Error).message);
  }
}

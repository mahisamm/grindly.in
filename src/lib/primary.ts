import { prisma } from "./prisma";

/**
 * Which resume this account is actually sending out.
 *
 * The stored id is a POINTER and is allowed to be wrong. It survives the delete
 * of the row it names — there is no foreign key, on purpose, because the two
 * available onDelete rules both do something worse than tolerating a dangling
 * id (see the schema comment on `User.primaryResumeId`). So every read goes
 * through here, and a stale pointer resolves to the same thing an account with
 * no pointer at all resolves to: their newest resume, which is what the product
 * treated as current before any of this existed.
 *
 * That fallback is the reason promotion can be non-destructive without adding a
 * migration that has to guess. Nobody's account needed a value backfilled.
 */
export function pickPrimary<T extends { id: string }>(
  resumes: T[],
  stored: string | null | undefined,
): T | null {
  if (!resumes.length) return null;
  if (stored) {
    const named = resumes.find((r) => r.id === stored);
    if (named) return named;
  }
  return resumes[0] ?? null;
}

/**
 * The primary resume's id, for callers that do not already hold the list.
 *
 * Ordered newest-first so the fallback matches `pickPrimary`. Both exist because
 * the resume list page already has every row in hand and should not pay for a
 * second query to answer a question it can answer from memory.
 */
export async function primaryResumeId(
  userId: string,
  stored: string | null | undefined,
): Promise<string | null> {
  if (stored) {
    const owned = await prisma.resume.findFirst({
      where: { id: stored, userId },
      select: { id: true },
    });
    if (owned) return owned.id;
  }
  const newest = await prisma.resume.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return newest?.id ?? null;
}

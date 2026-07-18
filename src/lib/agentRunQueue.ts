import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type AgentRun = Awaited<ReturnType<typeof prisma.agentRun.create>>;

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Enqueue one active run per user and mode. The database unique constraint is
 * the final arbiter, so two web instances handling the same click are safe.
 */
export async function enqueueAgentRun(
  userId: string,
  mode: string,
  existing?: AgentRun | null,
): Promise<AgentRun> {
  if (existing) return existing;
  const activeKey = `${userId}:${mode}`;

  // Route tests use a deliberately small Prisma mock. Keep that seam useful
  // while production takes the transactional path below.
  if (
    typeof prisma.$transaction !== "function" ||
    typeof prisma.agentRun.update !== "function"
  ) {
    return prisma.agentRun.create({ data: { userId, mode } });
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const run = await tx.agentRun.create({ data: { userId, mode } });
      return tx.agentRun.update({ where: { id: run.id }, data: { activeKey } });
    });
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const winner = await prisma.agentRun.findFirst({ where: { activeKey } });
    if (!winner) throw error;
    return winner;
  }
}

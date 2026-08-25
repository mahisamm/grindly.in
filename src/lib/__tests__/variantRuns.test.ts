import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRun, mockUser, mockTransaction } = vi.hoisted(() => {
  const mockRun = {
    findMany: vi.fn(),
    updateMany: vi.fn(),
    findFirst: vi.fn(),
  };
  const mockUser = { updateMany: vi.fn() };
  return {
    mockRun,
    mockUser,
    mockTransaction: vi.fn(async (work: (tx: unknown) => unknown) =>
      work({ variantRun: mockRun, user: mockUser }),
    ),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mockTransaction,
    variantRun: mockRun,
  },
}));

import { reapStaleRuns } from "@/lib/variantRuns";

beforeEach(() => {
  vi.clearAllMocks();
  mockRun.findMany.mockResolvedValue([{ id: "run-stale" }]);
  mockUser.updateMany.mockResolvedValue({ count: 1 });
});

describe("reapStaleRuns", () => {
  it("returns a free company rebuild claimed by an interrupted run", async () => {
    mockRun.updateMany.mockResolvedValue({ count: 1 });

    await reapStaleRuns("resume-1");

    expect(mockUser.updateMany).toHaveBeenCalledWith({
      where: { freeCompanyRunId: "run-stale" },
      data: { freeCompanyRunId: null },
    });
  });

  it("does not return the entitlement if the run completed during cleanup", async () => {
    mockRun.updateMany.mockResolvedValue({ count: 0 });

    await reapStaleRuns("resume-1");

    expect(mockUser.updateMany).not.toHaveBeenCalled();
  });
});

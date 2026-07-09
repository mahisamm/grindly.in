import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCount, mockQueryRaw, mockSendMessage } = vi.hoisted(() => ({
  mockCount: vi.fn(),
  mockQueryRaw: vi.fn(),
  mockSendMessage: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { agentRun: { count: mockCount }, $queryRaw: mockQueryRaw },
}));
vi.mock("@/lib/adapters/slack", () => ({ sendMessage: mockSendMessage }));

import { checkWorkerHeartbeat, checkBackupHealth, __resetWatchdogCooldown } from "@/lib/workerWatchdog";

beforeEach(() => {
  vi.resetAllMocks();
  mockSendMessage.mockResolvedValue({ ok: true, stub: true });
  __resetWatchdogCooldown();
});

describe("checkWorkerHeartbeat", () => {
  it("sends no alert when nothing is stale", async () => {
    mockCount.mockResolvedValue(0);
    await checkWorkerHeartbeat();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("alerts when a running job is stuck past the stale threshold", async () => {
    mockCount.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    await checkWorkerHeartbeat();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls[0][0].text).toContain("Worker looks dead");
  });

  it("alerts when jobs are stuck queued past the stale threshold", async () => {
    mockCount.mockResolvedValueOnce(0).mockResolvedValueOnce(3);
    await checkWorkerHeartbeat();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not re-alert within the cooldown window", async () => {
    mockCount.mockResolvedValue(1);
    await checkWorkerHeartbeat();
    await checkWorkerHeartbeat();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it("swallows errors instead of throwing", async () => {
    mockCount.mockRejectedValue(new Error("db down"));
    await expect(checkWorkerHeartbeat()).resolves.toBeUndefined();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});

describe("checkBackupHealth", () => {
  it("sends no alert when no row exists yet (pre-first-drill)", async () => {
    mockQueryRaw.mockResolvedValue([]);
    await checkBackupHealth();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("sends no alert when the last drill was recent and ok", async () => {
    mockQueryRaw.mockResolvedValue([{ last_restore_at: new Date(), last_restore_ok: true }]);
    await checkBackupHealth();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("alerts when the last drill failed", async () => {
    mockQueryRaw.mockResolvedValue([{ last_restore_at: new Date(), last_restore_ok: false }]);
    await checkBackupHealth();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls[0][0].text).toContain("restore drill failed");
  });

  it("alerts when the last drill is older than 36h", async () => {
    const old = new Date(Date.now() - 40 * 60 * 60 * 1000);
    mockQueryRaw.mockResolvedValue([{ last_restore_at: old, last_restore_ok: true }]);
    await checkBackupHealth();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls[0][0].text).toContain("stale");
  });

  it("does not re-alert within the cooldown window", async () => {
    mockQueryRaw.mockResolvedValue([{ last_restore_at: new Date(), last_restore_ok: false }]);
    await checkBackupHealth();
    await checkBackupHealth();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it("swallows errors instead of throwing (e.g. table doesn't exist yet)", async () => {
    mockQueryRaw.mockRejectedValue(new Error('relation "backup_health" does not exist'));
    await expect(checkBackupHealth()).resolves.toBeUndefined();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});

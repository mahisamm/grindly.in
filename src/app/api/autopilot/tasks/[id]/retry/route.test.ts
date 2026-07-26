import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The retry a person asks for.
 *
 * Nothing requeues `awaiting_human` automatically, and that is right: a task
 * that might already have submitted must never re-run on its own. But it left
 * the queue with no way out at all — twelve stopped tasks and no route back —
 * so this endpoint exists, with the duplicate guards the automatic path relies
 * on being absent.
 */

const { mockTaskFind, mockTaskUpdateMany, mockAppFind, mockEventCreate, mockUid } =
  vi.hoisted(() => ({
    mockTaskFind: vi.fn(),
    mockTaskUpdateMany: vi.fn(),
    mockAppFind: vi.fn(),
    mockEventCreate: vi.fn(),
    mockUid: vi.fn(),
  }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    browserTask: { findFirst: mockTaskFind, updateMany: mockTaskUpdateMany },
    application: { findUnique: mockAppFind },
    applicationEvent: { create: mockEventCreate },
  },
}));
vi.mock("@/lib/session", () => ({ getUid: mockUid }));

import { POST } from "./route";

const ctx = { params: Promise.resolve({ id: "t1" }) };
const req = new Request("http://x/api/autopilot/tasks/t1/retry", { method: "POST" });

beforeEach(() => {
  vi.resetAllMocks();
  mockUid.mockResolvedValue("u1");
  mockTaskUpdateMany.mockResolvedValue({ count: 1 });
  mockEventCreate.mockResolvedValue({});
  mockAppFind.mockResolvedValue({ status: "matched" });
  mockTaskFind.mockResolvedValue({ id: "t1", state: "awaiting_human", applicationId: "a1" });
});

describe("retrying a stopped task", () => {
  it("puts it back in the queue with a fresh attempt budget", async () => {
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    expect(mockTaskUpdateMany.mock.calls[0][0].data).toMatchObject({
      state: "queued",
      attempts: 0,
      blockedReason: null,
      leaseTokenHash: null,
      leaseExpiresAt: null,
    });
  });

  it("conditions the update on the state, so two clicks queue it once", async () => {
    await POST(req, ctx);
    expect(mockTaskUpdateMany.mock.calls[0][0].where).toMatchObject({
      id: "t1", userId: "u1", state: "awaiting_human",
    });
  });

  it.each(["applied", "needs_review"])(
    "refuses when the application is already %s",
    async (status) => {
      // The strongest evidence available that an employer received something.
      // Whatever the task row says, it must not be sent a second time.
      mockAppFind.mockResolvedValue({ status });
      const res = await POST(req, ctx);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "already_applied" });
      expect(mockTaskUpdateMany).not.toHaveBeenCalled();
    },
  );

  it.each(["leased", "filling", "submitted", "queued"])(
    "refuses to touch a task in %s",
    async (state) => {
      // leased/filling mean a tab is working on it right now; submitted is
      // terminal. Requeueing any of them asks for the second application.
      mockTaskFind.mockResolvedValue({ id: "t1", state, applicationId: "a1" });
      const res = await POST(req, ctx);
      expect(res.status).toBe(409);
      expect(mockTaskUpdateMany).not.toHaveBeenCalled();
    },
  );

  it("will not retry someone else's task", async () => {
    // The lookup is scoped by userId, so another user's id simply isn't found.
    mockTaskFind.mockResolvedValue(null);
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
    expect(mockTaskFind.mock.calls[0][0].where).toMatchObject({ userId: "u1" });
  });

  it("needs a session", async () => {
    mockUid.mockResolvedValue(null);
    expect((await POST(req, ctx)).status).toBe(401);
    expect(mockTaskFind).not.toHaveBeenCalled();
  });

  it("records the requeue on the application's timeline", async () => {
    await POST(req, ctx);
    expect(mockEventCreate.mock.calls[0][0].data).toMatchObject({
      applicationId: "a1", type: "requeued", actor: "user",
    });
  });

  it("survives a timeline write failing", async () => {
    // The requeue already happened; failing the request would invite a second
    // click on a task that is now queued.
    mockEventCreate.mockRejectedValue(new Error("db down"));
    expect((await POST(req, ctx)).status).toBe(200);
  });
});

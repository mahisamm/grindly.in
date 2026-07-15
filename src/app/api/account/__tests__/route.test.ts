import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetUid, mockClearUid, mockFindUnique, mockDelete, mockDeleteMany,
  mockTransaction, mockAudit,
} = vi.hoisted(() => ({
  mockGetUid: vi.fn(),
  mockClearUid: vi.fn(),
  mockFindUnique: vi.fn(),
  mockDelete: vi.fn(),
  mockDeleteMany: vi.fn(),
  mockTransaction: vi.fn(),
  mockAudit: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getUid: mockGetUid, clearUid: mockClearUid }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mockFindUnique, delete: mockDelete },
    passwordResetToken: { deleteMany: mockDeleteMany },
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/audit", () => ({ audit: mockAudit }));

import { DELETE } from "@/app/api/account/route";

function makeReq(body: unknown = { confirm: true }) {
  return new Request("http://localhost/api/account", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockFindUnique.mockResolvedValue({ email: "me@example.com" });
  mockDeleteMany.mockResolvedValue({ count: 0 });
  mockDelete.mockResolvedValue({});
  mockTransaction.mockResolvedValue([]);
  mockAudit.mockResolvedValue(undefined);
});

describe("DELETE /api/account", () => {
  it("returns 401 when there is no session", async () => {
    mockGetUid.mockResolvedValue(null);
    const res = await DELETE(makeReq());
    expect(res.status).toBe(401);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("refuses to delete without an explicit confirm", async () => {
    mockGetUid.mockResolvedValue("u1");
    const res = await DELETE(makeReq({ confirm: false }));
    expect(res.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("treats a missing/invalid body as unconfirmed", async () => {
    mockGetUid.mockResolvedValue("u1");
    // No body at all — req.json() throws and we must NOT delete.
    const bodyless = new Request("http://localhost/api/account", { method: "DELETE" });
    const res = await DELETE(bodyless);
    expect(res.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("clears the cookie and 404s when the user is already gone", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockFindUnique.mockResolvedValue(null);
    const res = await DELETE(makeReq());
    expect(res.status).toBe(404);
    expect(mockClearUid).toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("deletes the account, records an audit that survives the cascade, and clears the cookie", async () => {
    mockGetUid.mockResolvedValue("u1");
    const res = await DELETE(makeReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // The audit row must NOT be tagged with the user id, or the cascade delete
    // would take it down with the user — the whole point is that it outlives them.
    expect(mockAudit).toHaveBeenCalledWith(
      "account_deleted",
      expect.objectContaining({ userId: null, target: "me@example.com", detail: "u1" }),
    );
    // Reset tokens (bare user_id, no FK cascade) are cleared alongside the user.
    expect(mockDeleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
    expect(mockDelete).toHaveBeenCalledWith({ where: { id: "u1" } });
    expect(mockTransaction).toHaveBeenCalledOnce();
    expect(mockClearUid).toHaveBeenCalled();
  });
});

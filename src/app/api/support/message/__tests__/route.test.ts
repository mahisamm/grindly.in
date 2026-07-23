import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetUid, mockUserFind, mockTicketFind, mockTicketCreate, mockTicketUpdate,
  mockAudit, mockRate, mockAssist,
} = vi.hoisted(() => ({
  mockGetUid: vi.fn(),
  mockUserFind: vi.fn(),
  mockTicketFind: vi.fn(),
  mockTicketCreate: vi.fn(),
  mockTicketUpdate: vi.fn(),
  mockAudit: vi.fn(),
  mockRate: vi.fn(),
  mockAssist: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getUid: mockGetUid }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mockUserFind },
    supportTicket: { findFirst: mockTicketFind, create: mockTicketCreate, update: mockTicketUpdate },
  },
}));
vi.mock("@/lib/audit", () => ({ audit: mockAudit }));
vi.mock("@/lib/rateLimit", () => ({ isRateLimited: mockRate }));
// Only the network call is faked. isRepeatReply is pure and is exactly the
// behaviour the loop-breaker tests below assert on, so it stays real.
vi.mock("@/lib/supportAI", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supportAI")>()),
  supportAssist: mockAssist,
  SUPPORT_FALLBACK_REPLY: "FALLBACK",
  SUPPORT_OFFTOPIC_REPLY: "OFFTOPIC",
  SUPPORT_ESCALATION_REPLY: "ESCALATED",
}));

import { POST } from "@/app/api/support/message/route";

function req(body: unknown) {
  return new Request("http://localhost/api/support/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockGetUid.mockResolvedValue("u1");
  mockRate.mockResolvedValue(false);
  mockUserFind.mockResolvedValue({ name: "Ann", plan: "free", status: "active" });
  mockTicketFind.mockResolvedValue(null);
  mockTicketCreate.mockResolvedValue({ id: "t1" });
  mockTicketUpdate.mockResolvedValue({});
  mockAudit.mockResolvedValue(undefined);
  mockAssist.mockResolvedValue({ reply: "AI reply", subject: "Sub", category: "bug", severity: "high", summary: "sum" });
});

describe("POST /api/support/message", () => {
  it("401 with no session", async () => {
    mockGetUid.mockResolvedValue(null);
    const r = await POST(req({ message: "hi" }));
    expect(r.status).toBe(401);
    expect(mockTicketCreate).not.toHaveBeenCalled();
  });

  it("400 on an empty message", async () => {
    const r = await POST(req({ message: "   " }));
    expect(r.status).toBe(400);
    expect(mockAssist).not.toHaveBeenCalled();
  });

  it("429 when rate limited (and never calls the model)", async () => {
    mockRate.mockResolvedValue(true);
    const r = await POST(req({ message: "hi" }));
    expect(r.status).toBe(429);
    expect(mockAssist).not.toHaveBeenCalled();
  });

  it("creates a ticket, stores both turns, returns the AI reply, and audits", async () => {
    const r = await POST(req({ message: "my resume upload fails" }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ ticketId: "t1", reply: "AI reply", aiHandled: true });

    expect(mockTicketCreate).toHaveBeenCalledOnce();
    const data = mockTicketCreate.mock.calls[0][0].data;
    expect(data.userId).toBe("u1");
    expect(data.category).toBe("bug");
    expect(data.severity).toBe("high");
    const stored = JSON.parse(data.messagesJson);
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({ role: "user", content: "my resume upload fails" });
    expect(stored[1]).toMatchObject({ role: "assistant", content: "AI reply" });
    expect(mockAudit).toHaveBeenCalledWith("support_ticket_opened", expect.objectContaining({ userId: "u1" }));
  });

  it("falls back to the canned reply and default triage when the model is unavailable", async () => {
    mockAssist.mockResolvedValue(null);
    const r = await POST(req({ message: "hello" }));
    const j = await r.json();
    expect(j.aiHandled).toBe(false);
    expect(j.reply).toBe("FALLBACK");
    const data = mockTicketCreate.mock.calls[0][0].data;
    expect(data.category).toBe("other");
  });

  it("appends to an existing open ticket instead of creating a new one", async () => {
    mockTicketFind.mockResolvedValue({
      id: "t9", subject: "old", category: "account", severity: "normal", summary: "s",
      messagesJson: JSON.stringify([
        { role: "user", content: "earlier", at: "x" },
        { role: "assistant", content: "prev", at: "y" },
      ]),
    });
    const r = await POST(req({ message: "follow up" }));
    const j = await r.json();
    expect(j.ticketId).toBe("t9");
    expect(mockTicketCreate).not.toHaveBeenCalled();
    expect(mockTicketUpdate).toHaveBeenCalledOnce();
    const stored = JSON.parse(mockTicketUpdate.mock.calls[0][0].data.messagesJson);
    expect(stored).toHaveLength(4); // 2 prior + new user + new assistant
    expect(mockAudit).not.toHaveBeenCalled(); // audit fires only on ticket creation
  });

  // Regression: a beta user asked "why?" four times and got the same "for
  // security reasons" sentence back every time. The bot must hand off instead.
  it("breaks an answer loop: swaps in the escalation reply and forces severity high", async () => {
    const canned = "Grindly cannot auto-apply to jobs for security reasons, you apply yourself in Safe Apply Mode.";
    mockTicketFind.mockResolvedValue({
      id: "t9", subject: "old", category: "how_to", severity: "normal", summary: "s",
      messagesJson: JSON.stringify([
        { role: "user", content: "why can't it apply", at: "x" },
        { role: "assistant", content: canned, at: "y" },
      ]),
    });
    mockAssist.mockResolvedValue({
      // Same meaning, different wording — exactly what the model actually does.
      reply: "For security reasons Grindly cannot auto-apply to jobs; you apply yourself in Safe Apply Mode.",
      offTopic: false, subject: "Security", category: "how_to", severity: "normal", summary: "asked why",
    });
    const r = await POST(req({ message: "what are those security reasons" }));
    const j = await r.json();
    expect(j.reply).toBe("ESCALATED");
    expect(j.escalated).toBe(true);
    const data = mockTicketUpdate.mock.calls[0][0].data;
    expect(data.severity).toBe("high");
    expect(data.summary).toContain("NEEDS A HUMAN");
  });

  it("leaves a genuinely new answer alone", async () => {
    mockTicketFind.mockResolvedValue({
      id: "t9", subject: "old", category: "how_to", severity: "normal", summary: "s",
      messagesJson: JSON.stringify([
        { role: "user", content: "why can't it apply", at: "x" },
        { role: "assistant", content: "Grindly cannot auto-apply for security reasons.", at: "y" },
      ]),
    });
    mockAssist.mockResolvedValue({
      reply: "Three concrete reasons: the platforms' terms forbid automated submission and your account gets banned, we never hold your platform password, and some forms ask questions only you can answer truthfully.",
      offTopic: false, subject: "Security", category: "how_to", severity: "normal", summary: "explained",
    });
    const r = await POST(req({ message: "what are those security reasons" }));
    const j = await r.json();
    expect(j.escalated).toBe(false);
    expect(j.reply).toContain("terms forbid automated submission");
    expect(mockTicketUpdate.mock.calls[0][0].data.severity).toBe("normal");
  });

  it("refuses an off-topic request with a fixed redirect and files no ticket", async () => {
    mockAssist.mockResolvedValue({
      reply: "here is python code", offTopic: true, subject: "x", category: "other", severity: "low", summary: "s",
    });
    const r = await POST(req({ message: "write me python code for prime numbers" }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.offTopic).toBe(true);
    expect(j.reply).toBe("OFFTOPIC"); // server-controlled redirect, not the model's text
    expect(mockTicketCreate).not.toHaveBeenCalled();
    expect(mockTicketUpdate).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

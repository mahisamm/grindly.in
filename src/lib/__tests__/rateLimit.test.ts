import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    rateLimitEntry: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import { isRateLimited, getIp } from "@/lib/rateLimit";

const KEY = "test:127.0.0.1";
const WINDOW = 60_000;
const LIMIT = 5;
const NOW = new Date("2025-01-01T10:00:00Z");

beforeEach(() => {
  vi.resetAllMocks();
  vi.setSystemTime(NOW);
  delete process.env.TRUST_PROXY;
});

describe("isRateLimited", () => {
  it("allows first request (no existing entry)", async () => {
    mockPrisma.rateLimitEntry.findUnique.mockResolvedValue(null);
    mockPrisma.rateLimitEntry.upsert.mockResolvedValue({ count: 1 });

    const blocked = await isRateLimited(KEY, LIMIT, WINDOW);
    expect(blocked).toBe(false);
    expect(mockPrisma.rateLimitEntry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ count: 1 }) })
    );
  });

  it("allows request within limit", async () => {
    const windowEnd = new Date(NOW.getTime() + WINDOW);
    mockPrisma.rateLimitEntry.findUnique.mockResolvedValue({ count: 3, windowEnd });
    mockPrisma.rateLimitEntry.update.mockResolvedValue({ count: 4 });

    const blocked = await isRateLimited(KEY, LIMIT, WINDOW);
    expect(blocked).toBe(false);
  });

  it("blocks request over limit", async () => {
    const windowEnd = new Date(NOW.getTime() + WINDOW);
    mockPrisma.rateLimitEntry.findUnique.mockResolvedValue({ count: 5, windowEnd });
    mockPrisma.rateLimitEntry.update.mockResolvedValue({ count: 6 });

    const blocked = await isRateLimited(KEY, LIMIT, WINDOW);
    expect(blocked).toBe(true);
  });

  it("resets when window has expired", async () => {
    mockPrisma.rateLimitEntry.findUnique.mockResolvedValue({
      count: 10,
      windowEnd: new Date(NOW.getTime() - 1),
    });
    mockPrisma.rateLimitEntry.upsert.mockResolvedValue({ count: 1 });

    const blocked = await isRateLimited(KEY, LIMIT, WINDOW);
    expect(blocked).toBe(false);
    expect(mockPrisma.rateLimitEntry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ count: 1 }) })
    );
  });

  it("blocks at exactly limit+1", async () => {
    const windowEnd = new Date(NOW.getTime() + WINDOW);
    mockPrisma.rateLimitEntry.findUnique.mockResolvedValue({ count: LIMIT, windowEnd });
    mockPrisma.rateLimitEntry.update.mockResolvedValue({ count: LIMIT + 1 });

    const blocked = await isRateLimited(KEY, LIMIT, WINDOW);
    expect(blocked).toBe(true);
  });
});

describe("getIp", () => {
  it("extracts first IP from x-forwarded-for when TRUST_PROXY=1", () => {
    process.env.TRUST_PROXY = "1";
    const req = new Request("http://localhost", {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    });
    expect(getIp(req)).toBe("1.2.3.4");
  });

  it("ignores x-forwarded-for when TRUST_PROXY unset (prevents spoofing)", () => {
    delete process.env.TRUST_PROXY;
    const req = new Request("http://localhost", {
      headers: { "x-forwarded-for": "evil.attacker.ip" },
    });
    // Should not return the xff value
    expect(getIp(req)).not.toBe("evil.attacker.ip");
  });

  it("falls back to x-real-ip", () => {
    process.env.TRUST_PROXY = "1";
    const req = new Request("http://localhost", {
      headers: { "x-real-ip": "9.9.9.9" },
    });
    expect(getIp(req)).toBe("9.9.9.9");
  });

  it("returns unknown when no IP header present", () => {
    delete process.env.TRUST_PROXY;
    const req = new Request("http://localhost");
    expect(getIp(req)).toBe("unknown");
  });
});

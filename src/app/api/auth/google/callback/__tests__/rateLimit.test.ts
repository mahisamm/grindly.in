import { describe, it, expect, vi, beforeEach } from "vitest";

// Only the pieces the rate-limit branch touches need real behaviour; the Google
// token/userinfo round-trip is never reached in these cases.
const {
  mockCookieGet, mockCookieDelete, mockIsRateLimited, mockGetIp, mockLoginClient,
} = vi.hoisted(() => ({
  mockCookieGet: vi.fn(),
  mockCookieDelete: vi.fn(),
  mockIsRateLimited: vi.fn(),
  mockGetIp: vi.fn(() => "1.2.3.4"),
  mockLoginClient: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: mockCookieGet, delete: mockCookieDelete }),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { user: {} } }));
vi.mock("@/lib/session", () => ({ setUid: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/baseUrl", () => ({ baseUrl: () => "http://localhost" }));
vi.mock("@/lib/googleOAuth", () => ({
  loginClient: mockLoginClient,
  // Declared so the module factory is complete; these cases never reach the
  // Google round-trip, and a missing export would fail at import rather than in
  // the assertion.
  exchangeCode: vi.fn(),
  fetchProfile: vi.fn(),
}));
// The route now calls isRateLimitedByIp, which skips the limit entirely when
// there is no trustworthy client address — a shared "unknown" bucket was a
// global lockout waiting to be triggered. The assertions below are unchanged in
// meaning: they still check that the limiter is consulted, and that it is
// consulted only AFTER the cheap CSRF check.
vi.mock("@/lib/rateLimit", () => ({
  isRateLimited: mockIsRateLimited,
  isRateLimitedByIp: mockIsRateLimited,
  getIp: mockGetIp,
}));

import { GET } from "@/app/api/auth/google/callback/route";

// A callback URL that passes the CSRF state check (query state === cookie state).
function req(state = "abc") {
  return new Request(`http://localhost/api/auth/google/callback?code=xyz&state=${state}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  mockGetIp.mockReturnValue("1.2.3.4");
  mockCookieGet.mockReturnValue({ value: "abc" }); // saved state matches
});

describe("google callback rate limiting", () => {
  it("bounces to /login?error=rate_limited once the per-IP cap is hit", async () => {
    mockIsRateLimited.mockResolvedValue(true);
    const res = await GET(req());
    expect(res.status).toBe(307); // NextResponse.redirect default
    expect(res.headers.get("location")).toBe("http://localhost/login?error=rate_limited");
    // Keyed per IP, capped over an hour (kept high for shared campus/CGNAT IPs).
    expect(mockIsRateLimited).toHaveBeenCalledWith(
      expect.anything(), "oauth_cb", 100, 60 * 60 * 1000,
    );
    // Blocked before Google is ever contacted.
    expect(mockLoginClient).not.toHaveBeenCalled();
  });

  it("does not block a normal login (limiter returns false, flow continues)", async () => {
    mockIsRateLimited.mockResolvedValue(false);
    mockLoginClient.mockReturnValue(null); // stop at the next gate, proving we got past the limiter
    const res = await GET(req());
    expect(res.headers.get("location")).toBe("http://localhost/login?error=google_not_configured");
    expect(mockLoginClient).toHaveBeenCalled();
  });

  it("never reaches the limiter when the CSRF state fails", async () => {
    mockCookieGet.mockReturnValue({ value: "different" });
    const res = await GET(req("abc"));
    expect(res.headers.get("location")).toBe("http://localhost/login?error=google_state");
    expect(mockIsRateLimited).not.toHaveBeenCalled();
  });
});

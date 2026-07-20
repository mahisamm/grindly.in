import { prisma } from "@/lib/prisma";

/**
 * DB-backed rate limiter — survives multi-instance / serverless restarts.
 * Returns true if the request should be blocked (limit exceeded).
 *
 * Implementation: read → branch to reset or increment. The increment path
 * uses Prisma's atomic `{ increment: 1 }` which maps to a single
 * `UPDATE … SET count = count + 1` — safe under concurrent requests.
 * The window-reset path has a benign race (two concurrent resets both write
 * count=1) — worst case lets one extra request through at window boundary.
 * Behind Caddy (trusted proxy) this is acceptable; for stricter enforcement
 * swap to Redis INCR + EXPIRE.
 *
 * @param key      Unique bucket key — typically `"action:ip"`.
 * @param limit    Max requests allowed in the window.
 * @param windowMs Window duration in milliseconds.
 */
export async function isRateLimited(key: string, limit: number, windowMs: number): Promise<boolean> {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + windowMs);

  const entry = await prisma.rateLimitEntry.findUnique({ where: { key } });

  if (!entry || entry.windowEnd < now) {
    // Window expired or no entry — reset atomically via upsert.
    // Race: two simultaneous resets both write count=1 → benign (one extra
    // request through at most).
    await prisma.rateLimitEntry.upsert({
      where: { key },
      update: { count: 1, windowEnd },
      create: { key, count: 1, windowEnd },
    });
    return false;
  }

  // Atomic increment — never reads stale count before writing.
  const updated = await prisma.rateLimitEntry.update({
    where: { key },
    data: { count: { increment: 1 } },
  });

  return updated.count > limit;
}

/**
 * Extract best-effort client IP. Trusts x-forwarded-for only when the app
 * sits behind a known reverse proxy (TRUST_PROXY=1 env var). Without it,
 * x-forwarded-for is ignored to prevent IP spoofing.
 *
 * With exactly one trusted proxy hop (Caddy, per Caddyfile/docker-compose.yml
 * — TRUST_PROXY is only ever set for that deployment), the trustworthy value
 * is the LAST entry in x-forwarded-for, not the first: Caddy's reverse_proxy
 * appends the real client IP to whatever header the client already sent
 * rather than replacing it, so the first entry is still attacker-controlled.
 * Taking the first entry let anyone bypass every IP-keyed rate limit by
 * sending a fake x-forwarded-for header.
 */
export function getIp(req: Request): string {
  if (process.env.TRUST_PROXY === "1") {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const hops = xff.split(",").map((h) => h.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1];
    }
    const xri = req.headers.get("x-real-ip");
    if (xri) return xri;
  }
  // Fallback — not spoofable but may be proxy IP on cloud deployments
  return req.headers.get("x-real-ip") ?? "unknown";
}


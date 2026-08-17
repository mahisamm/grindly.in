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
/**
 * How often a call also sweeps expired rows away, as 1-in-N.
 *
 * The table is keyed by "action:ip" and "action:userId", so it gains a row per
 * distinct client per action and never loses one — every rate-limited request
 * from every IP that has ever hit the app, kept forever, to answer a question
 * about the last hour. On a box with one vCPU and 4 GB that is a slow leak with
 * no upper bound and no alarm attached to it.
 *
 * Swept opportunistically rather than on a schedule because there is no
 * scheduler here to hang it off. 1-in-50 means the sweep runs often enough to
 * keep the table small and rarely enough that it costs nothing measurable, and
 * a DELETE on an indexed timestamp with nothing to delete is close to free.
 */
const SWEEP_ONE_IN = 50;

async function sweepExpired(now: Date): Promise<void> {
  if (Math.random() * SWEEP_ONE_IN >= 1) return;
  // try/catch around the WHOLE body, not `.catch()` on the query.
  //
  // `.catch()` only handles a rejected promise. It does nothing about a
  // synchronous throw while building the call — `prisma.rateLimitEntry` being
  // undefined, the client not yet initialised — and that throw escapes into a
  // promise nobody is holding, because the caller deliberately does not await
  // this. Node treats an unhandled rejection as fatal by default, so a
  // housekeeping task that cannot possibly matter would take the process down
  // and every signed-in user with it.
  //
  // Caught by a test, in the least dramatic way possible: the rate-limit suite
  // mocks prisma without a `rateLimitEntry.deleteMany`, so the sweep threw
  // synchronously and vitest reported an unhandled rejection beside ten passing
  // assertions.
  try {
    await prisma.rateLimitEntry.deleteMany({ where: { windowEnd: { lt: now } } });
  } catch (e) {
    console.error("[rateLimit] sweep failed:", e);
  }
}

export async function isRateLimited(key: string, limit: number, windowMs: number): Promise<boolean> {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + windowMs);

  // Fire-and-forget: the caller is waiting on a permission decision, not on
  // garbage collection.
  void sweepExpired(now);

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
export function getIp(req: Request): string | null {
  if (process.env.TRUST_PROXY === "1") {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const hops = xff.split(",").map((h) => h.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1];
    }
    const xri = req.headers.get("x-real-ip");
    if (xri) return xri;
  }
  // Untrusted deployment: read NO client-supplied header. Any client can set
  // `x-real-ip` or `x-forwarded-for`, so honouring either without a proxy in
  // front means rotating one value defeats every IP-keyed limit.
  //
  // NULL, not a constant. This returned the string "unknown", which looks like
  // a safe fallback and is the opposite of one: every caller shares that
  // bucket, so `login:unknown` becomes a GLOBAL cap and one attacker
  // exhausting it locks every user out of signing in. That is a trivially
  // triggerable authentication denial of service, and it was the default on
  // any deploy not behind the bundled Caddy — Vercel, Fly, a bare `npm start`.
  //
  // Next's Web `Request` exposes no peer address, so there is nothing honest to
  // fall back to. Callers must therefore SKIP the IP-keyed limit when this is
  // null and lean on the account-keyed one (`login:acct:<email>`), which bounds
  // password guessing regardless of where it comes from and cannot be used to
  // lock out a third party.
  return null;
}

/**
 * Rate-limit by IP, but only when the IP is real.
 *
 * Returns false (not limited) when there is no trustworthy address, because a
 * shared bucket is worse than no bucket: it cannot stop a determined attacker
 * and it CAN be used by one to deny service to everybody else.
 */
export async function isRateLimitedByIp(
  req: Request,
  action: string,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  const ip = getIp(req);
  if (!ip) return false;
  return isRateLimited(`${action}:${ip}`, limit, windowMs);
}


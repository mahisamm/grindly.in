import { cookies } from "next/headers";

const COOKIE = "ip_uid";

export async function getUid(): Promise<string | null> {
  const c = await cookies();
  return c.get(COOKIE)?.value ?? null;
}

export async function setUid(uid: string) {
  const c = await cookies();
  c.set(COOKIE, uid, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearUid() {
  const c = await cookies();
  c.delete(COOKIE);
}

import { cookies } from "next/headers";
import { signSession, unsignSession } from "./sessionToken";

const COOKIE = "ip_uid";

export async function getUid(): Promise<string | null> {
  const c = await cookies();
  const raw = c.get(COOKIE)?.value;
  if (!raw) return null;
  return unsignSession(raw);
}

export async function setUid(uid: string) {
  const c = await cookies();
  c.set(COOKIE, signSession(uid), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
    secure: process.env.NODE_ENV === "production",
  });
}

export async function clearUid() {
  const c = await cookies();
  c.delete(COOKIE);
}

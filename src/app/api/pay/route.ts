import { NextResponse } from "next/server";
import { getUid } from "@/lib/session";
import { createOrder, type Plan } from "@/lib/adapters/payment";

export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { plan } = (await req.json().catch(() => ({}))) as { plan?: Plan };
  const chosen: Plan = plan === "pro" ? "pro" : "starter";

  const order = await createOrder({ userId: uid, plan: chosen });
  return NextResponse.json(order);
}

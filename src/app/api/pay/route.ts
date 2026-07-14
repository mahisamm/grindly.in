import { NextResponse } from "next/server";
import { getUid } from "@/lib/session";
import { createOrder, type Plan } from "@/lib/adapters/payment";

export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { plan } = (await req.json().catch(() => ({}))) as { plan?: Plan };
  const chosen: Plan = plan === "pro" ? "pro" : "starter";

  try {
    const order = await createOrder({ userId: uid, plan: chosen });
    return NextResponse.json(order);
  } catch (e) {
    console.error("[pay] createOrder failed:", e);
    return NextResponse.json(
      { error: "Could not start checkout. Please try again." },
      { status: 502 }
    );
  }
}

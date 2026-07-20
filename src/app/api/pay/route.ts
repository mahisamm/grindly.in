import { NextResponse } from "next/server";
import { getUid } from "@/lib/session";
import { createOrder, type Plan } from "@/lib/adapters/payment";

export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { plan } = (await req.json().catch(() => ({}))) as { plan?: Plan };
  const chosen: Plan = plan === "pro" ? "pro" : "plus";

  // Single explicit switch — not an environmental inference. The onboarding
  // button is labeled "coming soon" but was only ever disabled by
  // `busy || !tosAck`; without this it still ran a real checkout the moment
  // Razorpay keys existed in any environment where NODE_ENV wasn't literally
  // "production" (staging, key rotation, etc).
  if (process.env.PAYMENTS_ENABLED !== "true") {
    return NextResponse.json(
      { error: "Paid plans are coming soon. Your free plan (5 applications/day) stays active." },
      { status: 503 },
    );
  }
  if (process.env.NODE_ENV === "production" && (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET)) {
    return NextResponse.json(
      { error: "Paid plans are coming soon. Your free plan (5 applications/day) stays active." },
      { status: 503 },
    );
  }

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

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Logo } from "@/components/Brand";
import { TagInput } from "@/components/TagInput";
import { PROFF_FIELDS, DEFAULTS } from "@/lib/proffQuestions";
import { PLANS, type Plan } from "@/lib/adapters/payment";

type Form = Record<string, unknown>;

type RazorpayProof = {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
};

type RazorpayOptions = {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  handler: (proof: RazorpayProof) => void;
  theme: { color: string };
  modal: { ondismiss: () => void };
};

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => {
      open: () => void;
      on: (event: string, callback: () => void) => void;
    };
  }
}

function loadRazorpayCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src="https://checkout.razorpay.com/v1/checkout.js"]');
    const script = existing ?? document.createElement("script");
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("Razorpay Checkout failed to load")), { once: true });
    if (!existing) {
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.async = true;
      document.head.appendChild(script);
    }
  });
}

const STEPS = ["Resume", "Profile questions", "Notifications", "Activate"];

export default function OnboardingPage() {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<Form>({ ...DEFAULTS });
  const [resumeName, setResumeName] = useState<string | null>(null);
  const [resumeText, setResumeText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [slackId, setSlackId] = useState("");
  const [slackDone, setSlackDone] = useState(false);
  const [notifChannel, setNotifChannel] = useState<"slack" | "email">("email");
  const [plan, setPlan] = useState<Plan>("plus");
  const [busy, setBusy] = useState(false);
  const [tosAck, setTosAck] = useState(false);
  const [msg, setMsg] = useState("");
  const [upgradeMode, setUpgradeMode] = useState(false);

  // Gated beta guard: a not-yet-approved account that lands on /onboarding
  // (e.g. by typing the URL) is bounced to the waitlist. Admins pass.
  useEffect(() => {
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.user) return;
        if (d.user.role !== "admin" && d.user.accessStatus !== "approved") {
          window.location.href = "/waitlist";
        }
      })
      .catch(() => {});
  }, []);

  // hydrate from existing profile (if user comes back)
  useEffect(() => {
    fetch("/api/profile")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.profile) return;
        const p = d.profile;
        setForm({
          preferredDomains: JSON.parse(p.preferredDomains || "[]"),
          preferredLocations: JSON.parse(p.preferredLocations || "[]"),
          excludedCompanies: JSON.parse(p.excludedCompanies || "[]"),
          workMode: p.workMode,
          experienceLevel: p.experienceLevel || "student",
          stipendMin: p.stipendMin,
          minMatchScore: p.minMatchScore,
          maxPerDay: p.maxPerDay,
          autoApply: p.autoApply,
        });
        if (p.resumeName) setResumeName(p.resumeName);
        if (d.user?.slackConnected) setSlackDone(true);
      })
      .catch(() => {});
  }, []);

  // Pre-select the plan the user picked on the pricing page (stashed by /login
  // before the Google round-trip). Cleared once consumed.
  useEffect(() => {
    try {
      const p = localStorage.getItem("grindly_plan");
      if (p === "plus" || p === "pro") {
        // Syncing a value from an external store (localStorage) into React state —
        // the exact case this effect exists for. It can't be a lazy useState
        // initializer because localStorage is undefined during SSR.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setPlan(p);
        localStorage.removeItem("grindly_plan");
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("upgrade")) {
      // URL state is external browser state; sync it after hydration.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setUpgradeMode(true);
      setStep(3);
    }
  }, []);

  function set(key: string, v: unknown) {
    setForm((f) => ({ ...f, [key]: v }));
  }

  async function uploadResume(file: File) {
    setUploading(true);
    setMsg("");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/resume", { method: "POST", body: fd, signal: controller.signal });
      if (res.ok) {
        const j = await res.json();
        setResumeName(j.resumeName);
      } else {
        const j = await res.json().catch(() => ({}));
        setMsg(j.error || "Upload failed — try a PDF, DOCX or TXT.");
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        setMsg("Upload timed out — server took too long. Try again.");
      } else {
        setMsg("Upload failed — check your connection and try again.");
      }
    } finally {
      clearTimeout(timer);
      setUploading(false);
    }
  }

  async function savePasted() {
    if (!resumeText.trim()) return;
    await fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resumeText, resumeName: resumeName || "pasted-resume.txt" }),
    });
    setResumeName(resumeName || "pasted-resume.txt");
  }

  async function saveProff() {
    setBusy(true);
    await fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setBusy(false);
    setStep(2);
  }

  /** Persist the report channel. This choice used to live only in React state,
   *  so picking Email did nothing at all: the worker sent every report to Slack
   *  regardless, and there was no setting anywhere to change your mind. */
  async function saveReportChannel(channel: "slack" | "email") {
    await fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reportChannel: channel }),
    }).catch(() => null);
  }

  async function connectSlack() {
    setBusy(true);
    setMsg("");
    const res = await fetch("/api/slack/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slackUserId: slackId }),
    });
    if (res.ok) {
      await saveReportChannel("slack");
      setBusy(false);
      setSlackDone(true);
      setStep(3);
    } else {
      setBusy(false);
      setMsg("Enter your Slack member ID (e.g. U12345678).");
    }
  }

  async function pay() {
    setBusy(true);
    setMsg("");
    await fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoApply: Boolean(form.autoApply ?? true) }),
    }).catch(() => {});

    const confirmPayment = async (proof?: RazorpayProof) => {
      const response = await fetch("/api/pay/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, ...proof }),
      });
      if (!response.ok) throw new Error("Payment confirmation failed");
      window.location.href = "/dashboard";
    };

    try {
      const orderResponse = await fetch("/api/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      if (!orderResponse.ok) {
        const errorBody = await orderResponse.json().catch(() => ({}));
        throw new Error(errorBody.error || "Order creation failed");
      }
      const order = await orderResponse.json() as
        | { stub: true }
        | { stub: false; orderId: string; keyId: string; amount: number; currency: string };

      if (order.stub) {
        await confirmPayment();
        return;
      }

      await loadRazorpayCheckout();
      if (!window.Razorpay) throw new Error("Razorpay Checkout unavailable");
      const checkout = new window.Razorpay({
        key: order.keyId,
        amount: order.amount,
        currency: order.currency,
        name: "Grindly",
        description: `${PLANS[plan].name} plan`,
        order_id: order.orderId,
        handler: (proof) => {
          void confirmPayment(proof).catch(() => {
            setBusy(false);
            setMsg("Payment was received but confirmation failed. Contact support before paying again.");
          });
        },
        theme: { color: "#e3402a" },
        modal: {
          ondismiss: () => {
            setBusy(false);
            setMsg("Checkout closed. Your plan was not activated.");
          },
        },
      });
      checkout.on("payment.failed", () => {
        setBusy(false);
        setMsg("Payment failed. Check your payment details and try again.");
      });
      checkout.open();
    } catch (error) {
      setBusy(false);
      setMsg(error instanceof Error ? error.message : "Could not start checkout. Please try again.");
    }
  }

  async function activateTrial() {
    setBusy(true);
    setMsg("");
    await fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoApply: Boolean(form.autoApply ?? true) }),
    }).catch(() => {});
    const response = await fetch("/api/trial/activate", { method: "POST" });
    if (response.ok) {
      window.location.href = "/dashboard";
      return;
    }
    const body = await response.json().catch(() => ({}));
    setBusy(false);
    setMsg(body.error || "Could not start your free plan. Please try again.");
  }

  return (
    <main className="min-h-screen grid-bg">
      <div className="mx-auto max-w-3xl px-5 py-10">
        <Link href="/" className="flex justify-center mb-8">
          <Logo size={30} />
        </Link>

        {/* stepper */}
        <div className="flex items-center justify-center gap-2 mb-10">
          {STEPS.map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <div
                className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-sm border ${
                  i === step
                    ? "border-brand bg-brand/10 text-foreground"
                    : i < step
                      ? "border-accent/40 bg-accent/10 text-accent"
                      : "border-border text-muted"
                }`}
              >
                <span className="font-mono text-xs">{i < step ? "✓" : i + 1}</span>
                <span className="hidden sm:inline">{s}</span>
              </div>
              {i < STEPS.length - 1 && <span className="text-border">—</span>}
            </div>
          ))}
        </div>

        <div className="sticker rounded-3xl bg-surface p-7 animate-in">
          {/* STEP 0 — Resume */}
          {step === 0 && (
            <div>
              <h2 className="font-display text-2xl font-semibold">Upload your resume</h2>
              <p className="mt-1 text-sm text-muted">
                The agent extracts your skills from this to score every internship.
              </p>

              <label className="mt-5 flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-surface px-4 py-10 cursor-pointer hover:border-brand/60 transition">
                <input
                  type="file"
                  accept=".pdf,.doc,.docx,.txt"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) uploadResume(f);
                  }}
                />
                <span className="text-3xl">📄</span>
                <span className="text-sm">
                  {uploading
                    ? "Uploading…"
                    : resumeName
                      ? `Uploaded: ${resumeName}`
                      : "Click to upload PDF / DOCX / TXT"}
                </span>
              </label>

              <div className="my-5 flex items-center gap-3 text-xs text-muted">
                <div className="h-px flex-1 bg-border" /> or paste it
                <div className="h-px flex-1 bg-border" />
              </div>
              <textarea
                value={resumeText}
                onChange={(e) => setResumeText(e.target.value)}
                onBlur={savePasted}
                placeholder="Paste your resume text here…"
                rows={5}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand transition"
              />

              {msg && <p className="mt-3 text-sm text-danger">{msg}</p>}
              <div className="mt-6 flex justify-end">
                <button
                  disabled={!resumeName && !resumeText.trim()}
                  onClick={async () => {
                    await savePasted();
                    setStep(1);
                  }}
                  className="rounded-lg brand-gradient px-5 py-2.5 font-medium text-white hover:opacity-90 transition disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
          )}

          {/* STEP 1 — Profile questions */}
          {step === 1 && (
            <div>
              <h2 className="font-display text-2xl font-semibold">A few profile questions</h2>
              <p className="mt-1 text-sm text-muted">
                These are the hard limits the agent plans and applies inside — it can never cross them.
              </p>

              {(["Targeting", "Limits & rules"] as const).map((group) => (
                <div key={group} className="mt-6">
                  <div className="text-xs uppercase tracking-wide text-muted mb-3">{group}</div>
                  <div className="space-y-5">
                    {PROFF_FIELDS.filter((f) => f.group === group).map((f) => (
                      <div key={f.key}>
                        <label className="text-sm font-medium">{f.label}</label>
                        <p className="text-xs text-muted mb-1.5">{f.help}</p>
                        {f.type === "tags" && (
                          <TagInput
                            value={(form[f.key] as string[]) || []}
                            onChange={(v) => set(f.key, v)}
                            placeholder={f.placeholder}
                          />
                        )}
                        {f.type === "select" && (
                          <select
                            value={String(form[f.key] ?? "")}
                            onChange={(e) => set(f.key, e.target.value)}
                            className="w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-sm outline-none focus:border-brand transition capitalize"
                          >
                            {f.options!.map((o) => (
                              <option key={o} value={o}>
                                {o}
                              </option>
                            ))}
                          </select>
                        )}
                        {f.type === "number" && (
                          <div className="flex items-center gap-2">
                            <input
                              type="number"
                              value={Number(form[f.key] ?? 0)}
                              onChange={(e) => set(f.key, Number(e.target.value))}
                              className="w-32 rounded-lg border border-border bg-surface px-3 py-2.5 text-sm outline-none focus:border-brand transition"
                            />
                            <span className="text-sm text-muted">{f.suffix}</span>
                          </div>
                        )}
                        {f.type === "toggle" && (
                          <button
                            type="button"
                            onClick={() => set(f.key, !form[f.key])}
                            className={`relative h-7 w-12 rounded-full transition ${
                              form[f.key] ? "bg-accent" : "bg-surface-2 border border-border"
                            }`}
                          >
                            <span
                              className={`absolute top-1 size-5 rounded-full bg-white transition ${
                                form[f.key] ? "left-6" : "left-1"
                              }`}
                            />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              <div className="mt-7 flex justify-between">
                <button
                  onClick={() => setStep(0)}
                  className="rounded-lg border border-border px-5 py-2.5 hover:border-brand/60 transition"
                >
                  Back
                </button>
                <button
                  disabled={busy}
                  onClick={saveProff}
                  className="rounded-lg brand-gradient px-5 py-2.5 font-medium text-white hover:opacity-90 transition disabled:opacity-60"
                >
                  {busy ? "Saving…" : "Next"}
                </button>
              </div>
            </div>
          )}

          {/* STEP 2 — Notifications (Slack or Email) */}
          {step === 2 && (
            <div>
              <h2 className="font-display text-2xl font-semibold">Stay updated</h2>
              <p className="mt-1 text-sm text-muted">
                The agent sends you a daily progress report. Choose how you want to receive it.
              </p>

              {/* Channel picker */}
              <div className="mt-5 grid grid-cols-2 gap-3">
                <button
                  onClick={() => setNotifChannel("slack")}
                  className={`rounded-xl border-2 p-4 text-left transition ${notifChannel === "slack" ? "border-brand bg-brand/5" : "border-border hover:border-brand/40"}`}
                >
                  <div className="text-xl mb-1">💬</div>
                  <div className="font-semibold text-sm">Slack DM</div>
                  <div className="text-xs text-muted mt-0.5">Real-time DMs to your Slack account</div>
                </button>
                <button
                  onClick={() => setNotifChannel("email")}
                  className={`rounded-xl border-2 p-4 text-left transition ${notifChannel === "email" ? "border-brand bg-brand/5" : "border-border hover:border-brand/40"}`}
                >
                  <div className="text-xl mb-1">📧</div>
                  <div className="font-semibold text-sm">Email</div>
                  <div className="text-xs text-muted mt-0.5">Reports sent to your registered email</div>
                </button>
              </div>

              {/* Slack setup */}
              {notifChannel === "slack" && (
                <div className="mt-5">
                  <div className="rounded-xl border border-border bg-surface p-4 text-sm text-muted">
                    <p className="font-medium text-foreground">How to find your Slack member ID</p>
                    <ol className="mt-2 list-decimal pl-5 space-y-1">
                      <li>Open Slack → click your profile photo → <em>Profile</em>.</li>
                      <li>Click the <em>⋮ More</em> button → <em>Copy member ID</em>.</li>
                      <li>Paste it below (looks like <code className="text-brand-2">U08AB12CD</code>).</li>
                    </ol>
                  </div>
                  <input
                    value={slackId}
                    onChange={(e) => setSlackId(e.target.value)}
                    placeholder="U08AB12CD"
                    className="mt-4 w-full rounded-lg border border-border bg-surface px-3 py-2.5 outline-none focus:border-brand transition font-mono"
                  />
                  {slackDone && <p className="mt-2 text-sm text-accent">✓ Slack connected.</p>}
                </div>
              )}

              {/* Email — no setup needed */}
              {notifChannel === "email" && (
                <div className="mt-5 rounded-xl border border-accent/30 bg-accent/5 p-4 text-sm">
                  <p className="font-medium text-accent">✓ No setup needed</p>
                  <p className="mt-1 text-muted">
                    Daily reports + interview alerts go to your registered email automatically.
                    You can connect Slack later from the dashboard if you change your mind.
                  </p>
                </div>
              )}

              {msg && <p className="mt-2 text-sm text-danger">{msg}</p>}

              <div className="mt-6 flex flex-wrap justify-between gap-3">
                <button
                  onClick={() => setStep(1)}
                  className="rounded-lg border border-border px-5 py-2.5 hover:border-brand/60 transition"
                >
                  Back
                </button>
                <div className="flex flex-wrap gap-2">
                  {notifChannel === "slack" ? (
                    <>
                      <button
                        onClick={async () => { await saveReportChannel("email"); setStep(3); }}
                        className="rounded-lg border border-border px-5 py-2.5 text-muted hover:text-foreground transition"
                      >
                        Skip for now
                      </button>
                      <button
                        disabled={busy || !slackId.trim()}
                        onClick={connectSlack}
                        className="rounded-lg brand-gradient px-5 py-2.5 font-medium text-white hover:opacity-90 transition disabled:opacity-50"
                      >
                        {busy ? "Connecting…" : "Connect Slack"}
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={async () => { await saveReportChannel("email"); setStep(3); }}
                      className="rounded-lg brand-gradient px-5 py-2.5 font-medium text-white hover:opacity-90 transition"
                    >
                      Continue with Email →
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* STEP 3 — Activate */}
          {step === 3 && (
            <div>
              <h2 className="font-display text-2xl font-semibold">{upgradeMode ? "Plans are coming soon" : "Start free"}</h2>
              <p className="mt-1 text-sm text-muted">
                You&apos;re on the free plan — up to 5 applications a day, every day. Plus and Pro are coming soon.
              </p>

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                {(Object.entries(PLANS) as [Plan, (typeof PLANS)[Plan]][]).map(([key, p]) => (
                  <button
                    key={key}
                    onClick={() => setPlan(key)}
                    className={`rounded-xl border p-4 text-left transition ${
                      plan === key ? "border-brand bg-brand/10 glow" : "border-border bg-surface hover:border-brand/50"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{p.name}</span>
                      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">
                        Coming soon
                      </span>
                    </div>
                    <div className="mt-1 text-2xl font-semibold text-accent">
                      ₹{p.price}<span className="text-sm font-normal text-muted">/month</span>
                    </div>
                    <div className="mt-1 text-sm text-muted">{p.blurb}</div>
                  </button>
                ))}
              </div>

              {/* Safe Apply acknowledgement — final submission always remains user-controlled. */}
              <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
                <input
                  type="checkbox"
                  checked={tosAck}
                  onChange={(e) => setTosAck(e.target.checked)}
                  className="mt-0.5 size-4 accent-brand"
                />
                <span className="text-sm leading-relaxed text-muted">
                  I understand that Grindly prepares matches but I must complete every final
                  submission myself in the job platform. I have read the{" "}
                  <a href="/terms" target="_blank" className="text-brand-2 underline">
                    Terms of Service
                  </a>
                  .
                </span>
              </label>

              {msg && <p className="mt-3 text-sm text-danger">{msg}</p>}

              <div className="mt-6 flex flex-wrap justify-between gap-3">
                <button
                  onClick={() => upgradeMode ? (window.location.href = "/dashboard") : setStep(2)}
                  className="rounded-lg border border-border px-5 py-2.5 hover:border-brand/60 transition"
                >
                  Back
                </button>
                <div className="flex flex-wrap gap-2">
                  {!upgradeMode && (
                    <button
                      disabled={busy || !tosAck}
                      onClick={activateTrial}
                      className="rounded-lg brand-gradient px-6 py-2.5 font-medium text-white hover:opacity-90 transition disabled:opacity-60"
                    >
                      {busy ? "Activating…" : "Start free — 5 applications a day"}
                    </button>
                  )}
                  <button
                    disabled={busy || !tosAck}
                    onClick={pay}
                    title="Paid plans are coming soon"
                    className="rounded-lg border border-border px-5 py-2.5 font-medium text-muted hover:border-brand/40 transition disabled:opacity-60"
                  >
                    {busy ? "Please wait…" : `${PLANS[plan].name} — coming soon`}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

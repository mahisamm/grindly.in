"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Logo } from "@/components/Brand";
import { TagInput } from "@/components/TagInput";
import { PROFF_FIELDS, CONTACT_FIELDS, DEFAULTS } from "@/lib/proffQuestions";
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

// What the server will actually accept (see src/app/api/resume/route.ts).
// .doc is deliberately absent: the picker used to offer it and the server then
// rejected it, which is the worst of both worlds.
const ACCEPTED_EXT = [".pdf", ".docx", ".txt"];
const ACCEPTED_MIME = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
];
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
// Extensions alone are not enough in a file picker. Android's Drive/Files
// provider and some iOS pickers match on MIME type, and with an extension-only
// `accept` they grey out the user's PDF so it cannot be selected at all — the
// upload "fails" without a single request ever being sent.
const ACCEPT_ATTR = [
  ".pdf", ".docx", ".txt",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
].join(",");

export default function OnboardingPage() {
  const [step, setStep] = useState(0);
  // Readiness gaps returned by activation, rendered as a fix-this list.
  const [missing, setMissing] = useState<string[]>([]);
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
  // Server-computed (see /api/me), same pattern as gmailScanEnabled — not a
  // NEXT_PUBLIC_ build-time constant, so it actually responds to the
  // PAYMENTS_ENABLED env var at container runtime. Genuinely disables the
  // "coming soon" button instead of only gating it via `busy`/`tosAck`, which
  // still let a real checkout run whenever Razorpay keys happened to be
  // present in a non-strict-production environment.
  const [paymentsEnabled, setPaymentsEnabled] = useState(false);
  // Owner admin flag — surfaces the "Admin" jump button so the admin can leave
  // onboarding for the console at any time (they can complete it later).
  const [isAdmin, setIsAdmin] = useState(false);

  // Auth + gated-beta guard: a logged-out visitor (401) is bounced to /login,
  // same as /dashboard and /applications — previously a 401 resolved to
  // `null` here and just fell through with no redirect, so a signed-out (or
  // session-expired) visitor could fill out the whole wizard while every save
  // silently 401'd in the background. A not-yet-approved account is bounced
  // to the waitlist instead. Admins pass both checks.
  useEffect(() => {
    fetch("/api/me")
      .then((r) => {
        if (!r.ok) {
          window.location.href = "/login";
          return null;
        }
        return r.json();
      })
      .then((d) => {
        if (!d?.user) return;
        setPaymentsEnabled(!!d.user.paymentsEnabled);
        setIsAdmin(d.user.role === "admin");
        const allowed = d.user.hasAccess ?? (d.user.role === "admin" || d.user.accessStatus === "approved");
        if (!allowed) {
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
          // Eligibility facts. Hydrated so returning here to fix one field does
          // not blank the others back to defaults on the next save.
          education: p.education || "",
          gradYear: p.gradYear || 0,
          availability: p.availability || "",
          workAuthorization: p.workAuthorization || "",
          // Prefer whatever the agent already pulled off the resume — only
          // fall back to blank/0 if it hasn't run yet or found nothing.
          phone: p.phone || "",
          gpa: p.gpa || 0,
          // Only source is Google OAuth (see api/auth/google/callback) — blank
          // when Google didn't return one, with no other way to fill it in
          // until this field existed.
          name: d.user?.name || "",
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
    setMsg("");

    // Check locally first. Both of these used to cost a full upload before the
    // server said no — painful on a phone, and the resulting message arrived
    // long after the user had given up.
    const ext = (file.name.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();
    // An extensionless name is NOT a rejection: some Android/cloud pickers hand
    // over a file with no suffix, and the server treats those as PDF
    // (path.extname(...) || ".pdf" in src/app/api/resume/route.ts). Fall back to
    // the browser's MIME type so this local check can never be stricter than the
    // server's — refusing a file the server would have taken is the exact bug
    // this pre-check exists to avoid.
    const mimeOk = ACCEPTED_MIME.includes(file.type);
    if (ext && !ACCEPTED_EXT.includes(ext) && !mimeOk) {
      setMsg(
        ext === ".doc"
          ? "Old .doc files can't be read. Open it and 'Save as' PDF or DOCX, then upload that."
          : `We can't read ${ext} files. Upload a PDF, DOCX or TXT.`,
      );
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setMsg(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 5 MB. Export a smaller PDF and try again.`);
      return;
    }
    if (file.size === 0) {
      setMsg("That file is empty. Pick the actual resume file and try again.");
      return;
    }

    setUploading(true);
    try {
      // Two attempts. A phone on a weak uplink drops the connection mid-body far
      // more often than the server rejects anything — prod logs for the one real
      // upload failure show a client abort, not a server error.
      for (let attempt = 1; attempt <= 2; attempt++) {
        const controller = new AbortController();
        // 60s was too tight for a 4 MB PDF on mobile data; the abort landed while
        // the body was still uploading and read to the user as "upload failed".
        const timer = setTimeout(() => controller.abort(), 120_000);
        try {
          const fd = new FormData();
          fd.append("file", file);
          const res = await fetch("/api/resume", { method: "POST", body: fd, signal: controller.signal });
          if (res.ok) {
            const j = await res.json();
            setResumeName(j.resumeName);
            setMsg("");
            return;
          }
          const j = await res.json().catch(() => ({}));
          if (res.status === 403 && j.code === "access_pending") {
            // Distinct from a broken upload: nothing the user does to the file
            // will help. Say what is actually happening.
            setMsg("Your beta access is still pending approval, so uploads are locked. We'll email you the moment it's approved.");
            return;
          }
          // A 4xx is a verdict on the file — retrying sends the same bytes to the
          // same answer. Only network-level failures below are worth a second go.
          setMsg(j.error || "Upload failed — try a PDF, DOCX or TXT.");
          return;
        } catch (e) {
          const aborted = e instanceof Error && e.name === "AbortError";
          if (attempt === 1) continue; // one silent retry
          setMsg(aborted
            ? "Upload timed out — your connection dropped partway. Try again on a stronger network, or paste the text below."
            : "Upload failed — check your connection and try again, or paste the text below.");
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      setUploading(false);
    }
  }

  async function savePasted() {
    if (!resumeText.trim()) return;
    // Route pasted text through /api/resume as a .txt (same path as an uploaded
    // file) so it resets derived skills/score AND enqueues the "analyze" job.
    // Posting straight to /api/profile stored the text but queued nothing, so the
    // dashboard's Resume Intelligence panel showed a permanent, false "Analysis in
    // progress" for anyone who pasted instead of uploading.
    const name = (resumeName || "pasted-resume").replace(/\.[^.]+$/, "") + ".txt";
    const file = new File([resumeText], name, { type: "text/plain" });
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/resume", { method: "POST", body: fd });
    if (res.ok) {
      setResumeName(name);
    } else {
      setMsg("Could not save your resume — please try again.");
    }
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
    // Activation refuses while the agent lacks a fact it would have to state on
    // a form (lib/readiness). Name the missing items — "setup incomplete" with
    // no list is the kind of dead end a user cannot act on.
    if (body.code === "setup_incomplete" && Array.isArray(body.missing)) {
      setMissing(body.missing as string[]);
      setMsg("Finish these before the agent can apply for you:");
      return;
    }
    setMissing([]);
    setMsg(body.error || "Could not start your free plan. Please try again.");
  }

  return (
    <main className="min-h-screen grid-bg">
      <div className="mx-auto max-w-3xl px-5 py-10">
        <div className="relative mb-8 flex items-center justify-center">
          <Link href="/">
            <Logo size={30} />
          </Link>
          {isAdmin && (
            <Link
              href="/admin"
              className="absolute right-0 rounded-full border border-ink bg-ink px-3 py-1.5 text-sm font-semibold text-[var(--paper)] transition hover:opacity-80"
            >
              Admin
            </Link>
          )}
        </div>

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
                  accept={ACCEPT_ATTR}
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    // Reset the input so picking the SAME file again after a
                    // failure still fires onChange (it doesn't if the value is
                    // unchanged — a silent dead end for anyone retrying).
                    e.target.value = "";
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
                <span className="text-xs text-muted">Max 5 MB · text-based PDF, not a scan</span>
              </label>

              {/* Errors belong next to the thing that failed. This used to sit
                  below the paste box, out of sight on a phone. */}
              {msg && (
                <p className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                  {msg}
                </p>
              )}

              <div className="my-5 flex items-center gap-3 text-xs text-muted">
                <div className="h-px flex-1 bg-border" /> or paste it
                <div className="h-px flex-1 bg-border" />
              </div>
              <textarea
                value={resumeText}
                aria-label="Paste your resume text"
                onChange={(e) => setResumeText(e.target.value)}
                onBlur={savePasted}
                placeholder="Paste your resume text here…"
                rows={5}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand transition"
              />

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

              <div className="mt-6">
                <div className="text-xs uppercase tracking-wide text-muted mb-3">Contact</div>
                <p className="text-xs text-muted mb-3">
                  The agent grabs these from your resume when it can — check they&apos;re
                  right, or fill them in yourself.
                </p>
                <div className="space-y-5">
                  {CONTACT_FIELDS.map((f) => (
                    <div key={f.key}>
                      <label className="text-sm font-medium">{f.label}</label>
                      <p className="text-xs text-muted mb-1.5">{f.help}</p>
                      <div className="flex items-center gap-2">
                        <input
                          type={f.type}
                          aria-label={f.label}
                          value={String(form[f.key] ?? "")}
                          placeholder={"placeholder" in f ? f.placeholder : undefined}
                          onChange={(e) =>
                            set(f.key, f.type === "number" ? Number(e.target.value) : e.target.value)
                          }
                          className="w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-sm outline-none focus:border-brand transition"
                        />
                        {"suffix" in f && f.suffix && <span className="text-sm text-muted">{f.suffix}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {(["About you", "Targeting", "Limits & rules"] as const).map((group) => (
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
                            aria-label={f.label}
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
                        {f.type === "text" && (
                          <input
                            type="text"
                            aria-label={f.label}
                            value={String(form[f.key] ?? "")}
                            placeholder={f.placeholder}
                            onChange={(e) => set(f.key, e.target.value)}
                            className="w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-sm outline-none focus:border-brand transition"
                          />
                        )}
                        {f.type === "number" && (
                          <div className="flex items-center gap-2">
                            <input
                              type="number"
                              aria-label={f.label}
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
                            role="switch"
                            aria-checked={Boolean(form[f.key])}
                            aria-label={f.label}
                            onClick={() => set(f.key, !form[f.key])}
                            className={`relative h-7 w-12 rounded-full transition ${
                              form[f.key] ? "bg-accent" : "bg-surface-2 border border-border"
                            }`}
                          >
                            <span
                              aria-hidden="true"
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
                  aria-pressed={notifChannel === "slack"}
                  className={`rounded-xl border-2 p-4 text-left transition ${notifChannel === "slack" ? "border-brand bg-brand/5" : "border-border hover:border-brand/40"}`}
                >
                  <div className="text-xl mb-1">💬</div>
                  <div className="font-semibold text-sm">Slack DM</div>
                  <div className="text-xs text-muted mt-0.5">Real-time DMs to your Slack account</div>
                </button>
                <button
                  onClick={() => setNotifChannel("email")}
                  aria-pressed={notifChannel === "email"}
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
                    aria-label="Slack member ID"
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

              {/* Consent for what the agent will actually do.
                  This used to read "I must complete every final submission
                  myself", which describes only half of what happens: the agent
                  sends applications itself when they go to a company's own form
                  or inbox. A consent checkbox has to name the thing being
                  consented to, or it consents to nothing. */}
              <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
                <input
                  type="checkbox"
                  checked={tosAck}
                  onChange={(e) => setTosAck(e.target.checked)}
                  className="mt-0.5 size-4 accent-brand"
                />
                <span className="text-sm leading-relaxed text-muted">
                  I authorise Grindly to submit applications on my behalf when they go to a
                  company&apos;s own application form or hiring inbox, and I understand that
                  applications on LinkedIn, Naukri, Unstop and Indeed are prepared
                  for me to submit myself. Internshala submission is separately limited to its
                  staged beta flow. I can turn this off any time in my profile. I have
                  read the{" "}
                  <a href="/terms" target="_blank" className="text-brand-2 underline">
                    Terms of Service
                  </a>
                  .
                </span>
              </label>

              {msg && <p className="mt-3 text-sm text-danger">{msg}</p>}
              {missing.length > 0 && (
                <ul className="mt-2 space-y-1 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-muted">
                  {missing.map((m) => (
                    <li key={m} className="flex gap-2">
                      <span aria-hidden className="text-danger">•</span>
                      <span>{m}</span>
                    </li>
                  ))}
                </ul>
              )}
              {missing.length > 0 && (
                <button
                  onClick={() => setStep(1)}
                  className="mt-2 text-sm text-brand-2 underline"
                >
                  Fix these in the profile questions →
                </button>
              )}

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
                    disabled={busy || !tosAck || !paymentsEnabled}
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

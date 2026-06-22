"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Logo } from "@/components/Brand";
import { TagInput } from "@/components/TagInput";
import { PROFF_FIELDS, DEFAULTS } from "@/lib/proffQuestions";
import { PLANS, type Plan } from "@/lib/adapters/payment";

type Form = Record<string, unknown>;

const STEPS = ["Resume", "Proff questions", "Slack", "Activate"];

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<Form>({ ...DEFAULTS });
  const [resumeName, setResumeName] = useState<string | null>(null);
  const [resumeText, setResumeText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [slackId, setSlackId] = useState("");
  const [slackDone, setSlackDone] = useState(false);
  const [plan, setPlan] = useState<Plan>("starter");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

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

  function set(key: string, v: unknown) {
    setForm((f) => ({ ...f, [key]: v }));
  }

  async function uploadResume(file: File) {
    setUploading(true);
    setMsg("");
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/resume", { method: "POST", body: fd });
    setUploading(false);
    if (res.ok) {
      const j = await res.json();
      setResumeName(j.resumeName);
    } else {
      setMsg("Upload failed — try a PDF, DOCX or TXT.");
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

  async function connectSlack() {
    setBusy(true);
    setMsg("");
    const res = await fetch("/api/slack/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slackUserId: slackId }),
    });
    setBusy(false);
    if (res.ok) {
      setSlackDone(true);
      setStep(3);
    } else {
      setMsg("Enter your Slack member ID (e.g. U12345678).");
    }
  }

  async function pay() {
    setBusy(true);
    setMsg("");
    const res = await fetch("/api/pay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan }),
    });
    const j = await res.json();
    if (j.ok) {
      router.push("/dashboard?paid=1");
    } else {
      setBusy(false);
      setMsg("Could not activate. Try again.");
    }
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

          {/* STEP 1 — Proff questions */}
          {step === 1 && (
            <div>
              <h2 className="font-display text-2xl font-semibold">A few proff questions</h2>
              <p className="mt-1 text-sm text-muted">
                These set the agent&apos;s firewall — the boundaries it plans and applies inside.
              </p>

              {(["Targeting", "Firewall / limits"] as const).map((group) => (
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

          {/* STEP 2 — Slack */}
          {step === 2 && (
            <div>
              <h2 className="font-display text-2xl font-semibold">Connect Slack</h2>
              <p className="mt-1 text-sm text-muted">
                Right after payment the bot DMs you here to confirm details, then sends a
                progress report every day.
              </p>

              <div className="mt-5 rounded-xl border border-border bg-surface p-4 text-sm text-muted">
                <p className="font-medium text-foreground">How to find your Slack member ID</p>
                <ol className="mt-2 list-decimal pl-5 space-y-1">
                  <li>Open Slack → click your profile photo → <em>Profile</em>.</li>
                  <li>Click the <em>⋮ More</em> button → <em>Copy member ID</em>.</li>
                  <li>Paste it below (looks like <code className="text-brand-2">U08AB12CD</code>).</li>
                </ol>
                <p className="mt-2 text-xs">
                  Local build: this is stubbed — messages are logged to{" "}
                  <code>data/slack-outbox.jsonl</code> so you can see exactly what the bot would send.
                </p>
              </div>

              <input
                value={slackId}
                onChange={(e) => setSlackId(e.target.value)}
                placeholder="U08AB12CD"
                className="mt-4 w-full rounded-lg border border-border bg-surface px-3 py-2.5 outline-none focus:border-brand transition font-mono"
              />
              {slackDone && <p className="mt-2 text-sm text-accent">✓ Slack connected.</p>}
              {msg && <p className="mt-2 text-sm text-danger">{msg}</p>}

              <div className="mt-6 flex justify-between">
                <button
                  onClick={() => setStep(1)}
                  className="rounded-lg border border-border px-5 py-2.5 hover:border-brand/60 transition"
                >
                  Back
                </button>
                <div className="flex gap-2">
                  <button
                    onClick={() => setStep(3)}
                    className="rounded-lg border border-border px-5 py-2.5 text-muted hover:text-foreground transition"
                  >
                    Skip for now
                  </button>
                  <button
                    disabled={busy || !slackId.trim()}
                    onClick={connectSlack}
                    className="rounded-lg brand-gradient px-5 py-2.5 font-medium text-white hover:opacity-90 transition disabled:opacity-50"
                  >
                    {busy ? "Connecting…" : "Connect"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* STEP 3 — Activate */}
          {step === 3 && (
            <div>
              <h2 className="font-display text-2xl font-semibold">Choose your plan</h2>
              <p className="mt-1 text-sm text-muted">
                Pick a daily cap. Click Activate — agent starts immediately, no payment needed.
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
                      {key === "pro" && (
                        <span className="rounded-full bg-brand/20 px-2 py-0.5 text-xs text-brand-2">
                          Popular
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-2xl font-semibold text-accent">
                      Free
                      <span className="text-sm font-normal text-muted"> (beta)</span>
                    </div>
                    <div className="mt-1 text-sm text-muted">{p.blurb}</div>
                  </button>
                ))}
              </div>

              {msg && <p className="mt-3 text-sm text-danger">{msg}</p>}

              <div className="mt-6 flex justify-between">
                <button
                  onClick={() => setStep(2)}
                  className="rounded-lg border border-border px-5 py-2.5 hover:border-brand/60 transition"
                >
                  Back
                </button>
                <button
                  disabled={busy}
                  onClick={pay}
                  className="rounded-lg brand-gradient px-6 py-2.5 font-medium text-white hover:opacity-90 transition disabled:opacity-60"
                >
                  {busy ? "Activating…" : "Activate agent →"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

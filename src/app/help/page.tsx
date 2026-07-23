import Link from "next/link";
import { Logo } from "@/components/Brand";

export const metadata = { title: "Help & Support – Grindly" };

const FAQ: { q: string; a: string }[] = [
  {
    q: "Does Grindly apply to jobs automatically?",
    a: "No. Grindly finds matches, drafts a tailored resume and cover letter, and prepares each application — but you complete the final submission yourself in your own browser (Safe Apply Mode). Nothing is ever sent to an employer without you clicking submit.",
  },
  {
    q: "Why can't the agent just submit the application for me?",
    a: "Four concrete reasons, not just 'security'. (1) LinkedIn, Internshala, Naukri, Unstop and Indeed all forbid automated submission in their terms — an account caught doing it gets restricted or banned, and it is your account that is lost, not ours. (2) Grindly never stores your platform password, so by design it has no session to submit with — that is what stops a breach here from becoming a breach of your job accounts. (3) Many forms ask questions only you can answer truthfully (notice period, relocation, expected stipend, 'why this role'), and a bot answering those for you is misrepresentation to an employer. (4) You keep the last look at what goes out with your name on it. What you get instead: the roles found and scored, the cover letter and screening answers drafted, and a ready-to-submit link. The browser extension can auto-fill the form fields for you — the Submit click stays yours.",
  },
  {
    q: "Do I have to upload my resume on the job platform myself?",
    a: "Yes. You upload your resume to Grindly once so the agent can match and tailor it, but on the platform's own form you attach the file and press Submit yourself. Grindly does not upload files into the platform's form on your behalf — same reason the agent does not submit for you.",
  },
  {
    q: "What data is sent to AI providers?",
    a: "Resume and job text is sent to the AI ensemble to score matches and draft applications. Before anything leaves our servers it is passed through automatic redaction that strips direct identifiers — email, phone, and long ID/card numbers. Providers see your skills, not your contact details. Full detail is on the Privacy page.",
  },
  {
    q: "The agent says 'login required' — what do I do?",
    a: "Your saved browser session for that platform expired. Go to Dashboard → Integrations and reconnect the platform. The agent resumes on the next run.",
  },
  {
    q: "Why did it skip a listing?",
    a: "Every skip has a reason in your daily report: below your minimum match score, outside your domains/locations, an excluded company, under your stipend floor, or an unsupported/complex application flow. Lower your minimum match score to see more, raise it to be pickier.",
  },
  {
    q: "How do I pause the agent?",
    a: "Pause from the dashboard anytime. The scheduler skips paused accounts entirely until you resume.",
  },
  {
    q: "How do I delete my data?",
    a: "Delete your account and all associated data from the dashboard at any time, or email us for a manual deletion request. Platform connections can be revoked independently from the Integrations tab.",
  },
];

const TROUBLESHOOTING: { symptom: string; fix: string }[] = [
  { symptom: "No matches in my daily report", fix: "Your minimum match score may be too high, or your domains/locations too narrow. Widen them in onboarding or dashboard settings." },
  { symptom: "Resume upload failed", fix: "Use a PDF, DOCX, or TXT under the size limit. If a PDF is scanned (image-only), paste the text instead." },
  { symptom: "Not receiving reports", fix: "Check your report channel (Email or Slack) in settings. For Slack, confirm your member ID is correct (starts with U)." },
  { symptom: "A platform keeps disconnecting", fix: "Some platforms expire sessions frequently. Reconnect from Integrations; if it recurs, the platform may be challenging automated sessions." },
];

export default function HelpPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 text-ink">
      <nav className="mb-10 flex items-center justify-between" aria-label="Help page navigation">
        <Link href="/" aria-label="Grindly home"><Logo size={30} /></Link>
        <Link href="/dashboard" className="text-sm font-semibold text-brand hover:underline">Go to dashboard</Link>
      </nav>

      <h1 className="mb-2 font-display text-3xl font-semibold">Help &amp; Support</h1>
      <p className="mb-10 text-muted">
        Answers to the common questions, plus how to reach a human.
      </p>

      <section className="mb-12" aria-labelledby="faq-heading">
        <h2 id="faq-heading" className="mb-4 text-lg font-semibold">Frequently asked</h2>
        <div className="space-y-3">
          {FAQ.map((item) => (
            <details key={item.q} className="rounded-xl border border-border bg-surface p-4">
              <summary className="cursor-pointer list-none font-medium marker:content-none">
                <span className="text-brand-2">＋</span> {item.q}
              </summary>
              <p className="mt-2 text-sm leading-relaxed text-muted">{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="mb-12" aria-labelledby="trouble-heading">
        <h2 id="trouble-heading" className="mb-4 text-lg font-semibold">Troubleshooting</h2>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted">
                <th scope="col" className="py-2 pr-4 font-medium">If you see…</th>
                <th scope="col" className="py-2 font-medium">Try this</th>
              </tr>
            </thead>
            <tbody>
              {TROUBLESHOOTING.map((row) => (
                <tr key={row.symptom} className="border-b border-border/60 align-top">
                  <td className="py-3 pr-4 font-medium">{row.symptom}</td>
                  <td className="py-3 text-muted">{row.fix}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="contact-heading" className="rounded-xl border border-brand/30 bg-brand/5 p-5">
        <h2 id="contact-heading" className="mb-2 text-lg font-semibold">Still stuck?</h2>
        <p className="text-sm text-muted">
          Email{" "}
          <a href="mailto:mahendharsammeta21@gmail.com" className="font-semibold text-brand hover:underline">
            mahendharsammeta21@gmail.com
          </a>{" "}
          with your account email and what happened. We read every message during the beta.
        </p>
        <div className="mt-4 flex flex-wrap gap-4 text-sm">
          <Link href="/privacy" className="font-semibold text-brand hover:underline">Privacy Policy</Link>
          <Link href="/terms" className="font-semibold text-brand hover:underline">Terms of Service</Link>
        </div>
      </section>
    </main>
  );
}

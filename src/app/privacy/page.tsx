import Link from "next/link";
import { Logo } from "@/components/Brand";

export const metadata = { title: "Privacy Policy – Grindly" };

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 font-mono text-ink">
      <nav className="mb-10 flex items-center justify-between font-sans" aria-label="Legal page navigation">
        <Link href="/" aria-label="Grindly home"><Logo size={30} /></Link>
        <Link href="/" className="text-sm font-semibold text-brand hover:underline">Back to home</Link>
      </nav>
      <h1 className="mb-2 text-2xl font-bold text-ink">Privacy Policy</h1>
      <p className="mb-10 text-sm text-muted">Last updated: June 2026</p>

      <section className="mb-8">
        <h2 className="mb-3 text-base font-semibold text-ink">1. What we collect</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>Name and email address (via Google Sign-In)</li>
          <li>Resume content (uploaded or pasted by you)</li>
          <li>Job preferences: domains, locations, work mode, stipend range</li>
          <li>Platform credentials (encrypted with AES-256-GCM; we never store plaintext passwords)</li>
          <li>Application history: matches we prepared for you and that you submitted yourself, outcomes, and timestamps</li>
        </ul>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-base font-semibold text-ink">2. How we use your data</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>To match your resume to relevant internship listings</li>
          <li>To prepare applications for you to review and submit yourself in your own browser — Grindly never submits on your behalf</li>
          <li>To generate tailored cover letters using AI language models</li>
          <li>To send you progress reports via Slack or notification channels you configure</li>
        </ul>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-base font-semibold text-ink">3. Third-party services</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li><strong>Google OAuth</strong> — used for sign-in only; we receive your name and email</li>
          <li><strong>AI providers (Groq, Cerebras, Mistral, Gemini)</strong> — resume and cover-letter text is sent to score matches and draft applications. Before any text leaves our servers it is passed through an automatic redaction step that strips direct identifiers — email addresses, phone numbers, and long ID/card numbers are removed — so providers receive your skills and experience, not your contact details</li>
          <li><strong>LinkedIn, Naukri, Unstop, and Indeed</strong> — integrations use the browser session created when you log in yourself; Grindly does not receive or store those platform passwords</li>
          <li><strong>Internshala</strong> — if you choose the hosted credential-login flow, the credential is encrypted with AES-256-GCM before storage and used only to establish your browser session; plaintext is never stored</li>
          <li>We do not sell your data to third parties</li>
        </ul>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-base font-semibold text-ink">4. Data storage and security</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>All data is stored in a PostgreSQL database on a private server</li>
          <li>Platform credentials are encrypted at rest with AES-256-GCM</li>
          <li>Session tokens are HMAC-signed and transmitted over HTTPS only</li>
          <li>We retain your data for as long as your account is active</li>
        </ul>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-base font-semibold text-ink">5. Your rights</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>You can delete your account and all associated data at any time from the dashboard</li>
          <li>You can revoke platform connections at any time from the Integrations tab</li>
          <li>You can export your application history from the Applications page</li>
          <li>Residents of India may exercise rights under the DPDP Act 2023 by contacting us</li>
        </ul>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-base font-semibold text-ink">6. Contact</h2>
        <p className="text-sm">
          For privacy questions or data deletion requests, email:{" "}
          <a href="mailto:mahendharsammeta21@gmail.com" className="text-brand hover:underline">
            mahendharsammeta21@gmail.com
          </a>
        </p>
      </section>
      <footer className="mt-12 flex flex-wrap gap-5 border-t border-border pt-6 font-sans text-sm">
        <Link href="/terms" className="font-semibold text-brand hover:underline">Terms of Service</Link>
        <Link href="/login" className="font-semibold text-brand hover:underline">Sign in</Link>
      </footer>
    </main>
  );
}

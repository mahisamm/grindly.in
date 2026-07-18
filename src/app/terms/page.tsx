import Link from "next/link";
import { Logo } from "@/components/Brand";

export const metadata = { title: "Terms of Service – Grindly" };

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 font-mono text-ink">
      <nav className="mb-10 flex items-center justify-between font-sans" aria-label="Legal page navigation">
        <Link href="/" aria-label="Grindly home"><Logo size={30} /></Link>
        <Link href="/" className="text-sm font-semibold text-brand hover:underline">Back to home</Link>
      </nav>
      <h1 className="mb-2 text-2xl font-bold text-ink">Terms of Service</h1>
      <p className="mb-10 text-sm text-[#5a606b]">Last updated: June 2026</p>

      <section className="mb-8">
        <h2 className="mb-3 text-base font-semibold text-ink">1. What Grindly does</h2>
        <p className="text-sm leading-relaxed">
          Grindly is an AI-powered job application agent. When you enable auto-apply, Grindly
          uses a browser automation tool to submit internship applications on your behalf on
          platforms you have connected. The current beta supports Internshala; LinkedIn,
          Naukri, Unstop, and Indeed are planned but are not currently available to users.
          You remain solely responsible for all applications submitted through your account.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-base font-semibold text-ink">2. Eligibility</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>You must be at least 18 years old to use Grindly</li>
          <li>You must have a valid Google account to sign in</li>
          <li>You must have legitimate accounts on any job platform you connect</li>
        </ul>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-base font-semibold text-ink">3. Your responsibilities</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>You are responsible for the accuracy of your resume and profile information</li>
          <li>You must only connect accounts that you own and are authorized to use</li>
          <li>You must comply with the terms of service of each job platform you connect</li>
          <li>You must not use Grindly to submit false, misleading, or fraudulent applications</li>
          <li>Setting a reasonable daily application cap is your responsibility — excessive applications may result in your job platform accounts being restricted</li>
        </ul>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-base font-semibold text-ink">4. Beta service</h2>
        <p className="text-sm leading-relaxed">
          Grindly is currently in beta. The service is provided as-is, without warranty of any kind.
          Features may change, be unavailable, or behave unexpectedly. We are not liable for any
          missed applications, account restrictions on third-party platforms, or any other damages
          resulting from use of this service.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-base font-semibold text-ink">5. Acceptable use</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>Do not attempt to reverse-engineer, scrape, or abuse the Grindly API</li>
          <li>Do not use Grindly to harass employers or submit spam applications</li>
          <li>Do not share your account credentials with others</li>
          <li>Accounts found to be in violation may be suspended without notice</li>
        </ul>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-base font-semibold text-ink">6. Limitation of liability</h2>
        <p className="text-sm leading-relaxed">
          To the maximum extent permitted by law, Grindly and its operators shall not be liable
          for any indirect, incidental, or consequential damages, including but not limited to
          loss of employment opportunities, platform account bans, or data loss.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-base font-semibold text-ink">7. Changes to these terms</h2>
        <p className="text-sm leading-relaxed">
          We may update these terms from time to time. Continued use of Grindly after changes
          are posted constitutes acceptance of the new terms.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-base font-semibold text-ink">8. Contact</h2>
        <p className="text-sm">
          Questions about these terms:{" "}
          <a href="mailto:mahendharsammeta21@gmail.com" className="text-[#6c8cf4] hover:underline">
            mahendharsammeta21@gmail.com
          </a>
        </p>
      </section>
      <footer className="mt-12 flex flex-wrap gap-5 border-t border-border pt-6 font-sans text-sm">
        <Link href="/privacy" className="font-semibold text-brand hover:underline">Privacy Policy</Link>
        <Link href="/login" className="font-semibold text-brand hover:underline">Sign in</Link>
      </footer>
    </main>
  );
}

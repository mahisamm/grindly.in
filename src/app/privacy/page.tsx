import Link from "next/link";
import type { Metadata } from "next";
import { Logo } from "@/components/Brand";

export const metadata: Metadata = { title: "Privacy — Grindly" };

const UPDATED = "16 August 2026";

/**
 * Written to be read, and to be true.
 *
 * A resume is a dossier: name, phone, address, education, employment history,
 * sometimes date of birth and a photograph. Under India's DPDP Act 2023 that is
 * personal data and this is a data fiduciary. The page says what is collected,
 * where it goes, and how to get rid of it, in the order a worried person asks.
 */
export default function PrivacyPage() {
  return (
    <>
      <header className="border-border border-b">
        <nav className="mx-auto flex max-w-4xl items-center justify-between px-5 py-4 sm:px-6 sm:py-5">
          <Link href="/"><Logo /></Link>
          <Link href="/terms" className="text-muted hover:text-ink text-sm">Terms</Link>
        </nav>
      </header>

      <main className="prose-grindly mx-auto max-w-3xl flex-1 px-5 py-10 sm:px-6 sm:py-14">
        <h1 className="font-display text-4xl font-bold">Privacy</h1>
        <p className="text-muted mt-2 text-sm">Last updated {UPDATED}</p>

        <Section title="The short version">
          <p>
            We store your resume and what we measured from it. We do not sell it,
            we do not train models on it, and we do not send applications
            anywhere on your behalf. Delete your account and the files go with it.
          </p>
        </Section>

        <Section title="What we collect">
          <ul>
            <li>
              <b>Your account.</b> Email address, an optional name, and either a
              password hash (scrypt — we never store the password) or a Google
              account id if you sign in that way.
            </li>
            <li>
              <b>Your resume.</b> The file you upload, the text extracted from it,
              and the contact details read off its header. A resume commonly
              contains your phone number, address, education and employment
              history; whatever is in yours is in ours.
            </li>
            <li>
              <b>What we measured.</b> Readiness scores, findings, the rebuilt
              PDFs, and any job description you paste in.
            </li>
            <li>
              <b>Operational records.</b> Sign-in events, rate-limit counters, and
              errors. IP addresses appear in rate-limit keys and are not kept as a
              browsing history.
            </li>
            <li>
              <b>Anonymous page activity.</b> A random first-party browser id, the
              page path and time of a visit, plus an optional campaign label or
              referring website hostname. We do not store IP addresses, a full
              referrer URL, search terms or advertising click identifiers.
            </li>
          </ul>
          <p>
            We do not use advertising trackers, and there is no third-party
            analytics script on this site.
          </p>
        </Section>

        <Section title="Where your resume goes">
          <p>
            The score is computed entirely on our own server by a deterministic
            program. No model is involved and nothing leaves the machine.
          </p>
          <p>
            Rewriting and the written review DO send resume text to a language
            model provider — currently Groq, Google Gemini, Cerebras, Mistral,
            OpenRouter or xAI,
            whichever the deployment has configured. Before any text leaves the
            server we strip email addresses, phone numbers and long identity
            numbers from it. Those providers receive your skills and experience;
            they do not receive your contact details.
          </p>
          <p>
            Your name is not stripped, because a rewrite has to keep it and no
            name detector is reliable enough to remove it without mangling
            ordinary resume text. If that matters to you, do not use the rewrite
            feature — the readiness report works without it.
          </p>
        </Section>

        <Section title="How long we keep it">
          <p>
            Until you delete it. Deleting a resume removes the row, the uploaded
            file and every rebuilt PDF made from it. Deleting your account removes
            everything above.
          </p>
          <p>
            Operational records — sign-in events and error reports — are kept
            separately for security and debugging, and are not linked to your
            resume content.
          </p>
        </Section>

        <Section title="Your rights">
          <p>
            You can see everything we hold from your account page, correct it by
            re-uploading, and delete it at any time without asking us. Under
            India&rsquo;s Digital Personal Data Protection Act 2023 — and under the
            GDPR if you are in the EU — you may also request a copy or a
            correction by email, and we will respond within 30 days.
          </p>
        </Section>

        <Section title="Security">
          <p>
            Sessions are signed cookies, revocable on sign-out. Passwords are
            hashed with scrypt. Uploaded files are stored outside the web root and
            served only through a route that checks you own them. Rendering runs
            with JavaScript disabled and no network access.
          </p>
          <p>
            No system is perfect. If you find a problem, tell us before you tell
            anyone else and we will fix it.
          </p>
        </Section>

        <Section title="Children">
          <p>
            Grindly is not intended for anyone under 16, and we do not knowingly
            hold data about them.
          </p>
        </Section>

        <Section title="Changes">
          <p>
            If we change how your data is handled in a way that matters, we will
            update the date at the top and say what changed.
          </p>
        </Section>
      </main>

      <footer className="border-border border-t">
        <div className="text-muted mx-auto flex max-w-4xl flex-wrap gap-5 px-5 py-8 sm:px-6 text-sm">
          <Link href="/" className="hover:text-ink">Home</Link>
          <Link href="/terms" className="hover:text-ink">Terms</Link>
          <Link href="/refunds" className="hover:text-ink">Refunds</Link>
          <Link href="/contact" className="hover:text-ink">Contact</Link>
        </div>
      </footer>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="font-display text-2xl font-semibold">{title}</h2>
      <div className="mt-3 flex flex-col gap-3 leading-relaxed [&_li]:mb-2 [&_ul]:list-disc [&_ul]:pl-5">
        {children}
      </div>
    </section>
  );
}

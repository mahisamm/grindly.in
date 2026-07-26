import Link from "next/link";

export const metadata = {
  title: "Grindly Extension — Privacy Policy",
  description: "What the Grindly Apply Assistant browser extension accesses, and what it does not.",
};

// Public, static privacy policy for the browser extension. The Chrome Web Store
// requires a hosted privacy policy URL; this is it (https://grindly.in/extension/privacy).
export default function ExtensionPrivacyPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <Link href="/" className="text-sm text-brand-2 hover:underline">← Grindly</Link>
        <h1 className="mt-4 text-3xl font-bold">Grindly Apply Assistant — Privacy Policy</h1>
        <p className="mt-2 text-sm text-muted">Last updated: 20 July 2026</p>

        <section className="mt-8 space-y-4 text-sm leading-relaxed text-foreground/90">
          <p>
            The Grindly Apply Assistant browser extension helps you fill job-application forms with
            content your Grindly account already prepared (a tailored resume, cover letter, and
            drafted answers). It runs entirely in your own browser. This policy explains exactly
            what it touches.
          </p>

          <h2 className="pt-4 text-lg font-semibold">What it accesses</h2>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <strong>Your Grindly account, on your behalf.</strong> When you connect the extension,
              your browser stores a token that lets it request <em>your own</em> application kits
              from grindly.in. The token is stored only in your browser and can be revoked at any
              time from your dashboard or the extension popup.
            </li>
            <li>
              <strong>The job page you’re on.</strong> On the supported sites (Internshala, LinkedIn,
              Naukri, Unstop, Indeed) the extension reads the current page’s address to look up the
              matching kit, and — only when you click “Fill with Grindly” — reads and fills the
              application form’s fields.
            </li>
          </ul>

          <h2 className="pt-4 text-lg font-semibold">What it does not do</h2>
          <ul className="list-disc space-y-2 pl-5">
            <li>Normal “Fill with Grindly” leaves final submission to you. If the optional Autopilot beta is enabled by Grindly and you turn it on, it may submit a leased task only in your own signed-in browser; it stops for CAPTCHA, OTP, unsupported flows, and questions it cannot answer.</li>
            <li>It never reads pages outside the supported job sites and grindly.in.</li>
            <li>It never sees your job-platform passwords, and never stores form contents.</li>
            <li>It does not sell, share, or transfer your data to any third party.</li>
            <li>It contains no analytics, ads, or tracking.</li>
          </ul>

          <h2 className="pt-4 text-lg font-semibold">Data flow</h2>
          <p>
            The extension’s background service worker requests your kit from grindly.in over HTTPS
            using your token, and passes it to the page only to fill the form. Nothing is sent to
            any server other than grindly.in, and nothing about the pages you visit is logged.
          </p>

          <h2 className="pt-4 text-lg font-semibold">Removing your data</h2>
          <p>
            Disconnect the extension (popup → Disconnect, or dashboard → revoke) to delete its
            stored token. Uninstalling the extension removes all of its local storage. Your Grindly
            account data is governed by the main{" "}
            <Link href="/privacy" className="text-brand-2 underline">Grindly Privacy Policy</Link>.
          </p>

          <h2 className="pt-4 text-lg font-semibold">Contact</h2>
          <p>Questions: support@grindly.in</p>
        </section>
      </div>
    </main>
  );
}

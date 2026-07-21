import type { Metadata, Viewport } from "next";
import { Fraunces, Space_Grotesk, JetBrains_Mono } from "next/font/google";
import Script from "next/script";
import Track from "@/components/Track";
import "./globals.css";

const bodySans = Space_Grotesk({
  variable: "--ff-sans",
  subsets: ["latin"],
  display: "swap",
  preload: false,
});

const codeMono = JetBrains_Mono({
  variable: "--ff-mono",
  subsets: ["latin"],
  display: "swap",
  preload: false,
});

// Editorial serif display — variable weight + italic (proto uses 900 + italic accents)
const displayFont = Fraunces({
  variable: "--ff-display",
  subsets: ["latin"],
  style: ["normal", "italic"],
  display: "swap",
  preload: false,
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#f2ece1",
};

export const metadata: Metadata = {
  title: "Grindly — your AI preps internship applications while you sleep",
  description:
    "Grindly reads your resume, finds matching internships, and prepares supported applications for your approval. Daily updates via Slack or email.",
  verification: {
    google: "-dvm3t95vbpe8XdI2ddbTpQG5lK5pPKgY_X3ZBzLp7Q",
  },
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Grindly",
  },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    apple: [
      { url: "/apple-touch-icon.svg", type: "image/svg+xml" },
    ],
  },
  openGraph: {
    title: "Grindly — AI Internship Agent",
    description: "Your AI preps internship applications while you sleep — you review and submit. Upload your resume, set preferences, done.",
    siteName: "Grindly",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Grindly — AI Internship Agent",
    description: "Your AI preps internship applications while you sleep — you review and submit.",
  },
  formatDetection: {
    telephone: false,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${bodySans.variable} ${codeMono.variable} ${displayFont.variable} h-full antialiased`}
    >
      <head>
        <link rel="manifest" href="/manifest.json" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="Grindly" />
      </head>
      <body className="min-h-full flex flex-col">
        {/* Keyboard/screen-reader users: jump straight past the nav to content. */}
        <a href="#main-content" className="skip-link">Skip to main content</a>
        <div className="grain-fixed" aria-hidden="true" />
        <Track />
        <div id="main-content" tabIndex={-1} className="flex min-h-full flex-col outline-none">
          {children}
        </div>
        {/* External file, not an inline body — lets script-src drop 'unsafe-inline'
            for the app's own scripts (see next.config.ts CSP comment). */}
        <Script src="/sw-register.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}

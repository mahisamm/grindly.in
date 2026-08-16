import type { Metadata, Viewport } from "next";
import { Fraunces, Space_Grotesk, JetBrains_Mono } from "next/font/google";
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
  title: "Grindly — see your resume the way a machine reads it",
  description:
    "Grindly measures what survives when a parser reads your resume, rebuilds it as a clean single-column PDF, and tailors it to the company you are applying to — without inventing a single fact.",
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
    title: "Grindly — see your resume the way a machine reads it",
    description:
      "Measure what a parser actually recovers from your resume, rebuild it clean, and tailor it per company. Every number measured, nothing invented.",
    siteName: "Grindly",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Grindly — see your resume the way a machine reads it",
    description: "Measure what a parser recovers from your resume, rebuild it clean, tailor it per company.",
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
        <div id="main-content" tabIndex={-1} className="flex min-h-full flex-col outline-none">
          {children}
        </div>
      </body>
    </html>
  );
}

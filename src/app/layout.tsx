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
        {/*
          Apply the saved theme BEFORE the first paint.

          Without this, a reader who chose dark gets one frame of the light
          palette on every navigation that hits the server — a white flash on a
          dark page, at the moment the page is least able to hide it. There is
          no way to do this from React: the attribute has to be on <html> before
          the browser draws anything, and the earliest that can happen is a
          blocking script in the head.

          It reads the same key the toggle writes, and does nothing at all when
          the choice is "system" — the CSS already honours prefers-color-scheme
          on its own.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('grindly-theme');" +
              "if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t);}catch(e){}",
          }}
        />
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

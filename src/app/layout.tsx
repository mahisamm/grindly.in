import type { Metadata, Viewport } from "next";
import { Fraunces, Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { TrafficBeacon } from "@/components/TrafficBeacon";
import { ThemeBootstrap } from "@/components/ThemeBootstrap";

const bodySans = Space_Grotesk({
  variable: "--ff-sans",
  subsets: ["latin"],
  display: "swap",
  // Preloaded: it paints every page's first words, and un-preloaded it
  // arrives mid-render — text visibly re-set a beat after appearing.
  preload: true,
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
  // Preloaded for one reason above all: the GRINDLY intro letters are set in
  // this face, and without the preload a first-time visitor watched them rise
  // in the fallback serif and SWAP to Fraunces mid-animation — the jank the
  // splash exists to not have.
  preload: true,
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#f2ece1",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://grindly.in"),
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
    url: "/",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Grindly — see your resume the way a machine reads it",
    description: "Measure what a parser recovers from your resume, rebuild it clean, tailor it per company.",
  },
  alternates: {
    canonical: "/",
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
      suppressHydrationWarning
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
              // The intro decision is made pre-paint because the landing curtain
              // must be visible before the first frame. Theme selection is not:
              // changing `data-theme` before hydration makes React reconcile a
              // different root DOM on every page, so ThemeBootstrap applies it
              // only after React owns the document.
              //
              // The intro decision, made pre-paint for the same reason as the
              // theme: the splash used to appear only after React hydrated,
              // so a first-time visitor saw the landing paint, THEN a curtain
              // pop over it — the least smooth possible opening. Now the
              // attribute is on <html> before the first frame; CSS shows the
              // (always-rendered) splash instantly and the letters animate
              // from paint one. Landing page only; once per session; never
              // under reduced motion.
              "try{if(location.pathname==='/'&&!sessionStorage.getItem('grindly:intro-seen')" +
              "&&!matchMedia('(prefers-reduced-motion: reduce)').matches){" +
              "document.documentElement.setAttribute('data-intro','1');" +
              "sessionStorage.setItem('grindly:intro-seen','1');}}catch(e){}",
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
        {/* The `min-w-0` here and the `#main-content > *` rule in globals.css
            are one fix; see the note there for what it is for. */}
        <div
          id="main-content"
          tabIndex={-1}
          className="flex min-h-full min-w-0 flex-col outline-none"
        >
          {children}
        </div>
        {/* Page-view beacon — see components/TrafficBeacon.tsx for what it
            does and does not record. Last in the body so it never delays
            anything the visitor is waiting for. */}
        <TrafficBeacon />
        <ThemeBootstrap />
      </body>
    </html>
  );
}

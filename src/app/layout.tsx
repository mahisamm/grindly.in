import type { Metadata, Viewport } from "next";
import { Orbitron, Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";

const bodySans = Hanken_Grotesk({
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

const displayFont = Orbitron({
  variable: "--ff-display",
  subsets: ["latin"],
  display: "swap",
  preload: false,
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#2a28f0",
};

export const metadata: Metadata = {
  title: "Grindly — your AI applies to internships while you sleep",
  description:
    "Grindly reads your resume, finds matching internships, and auto-applies for you. Daily progress updates via Slack or email.",
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
    description: "Your AI applies to internships while you sleep. Upload your resume, set preferences, done.",
    siteName: "Grindly",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Grindly — AI Internship Agent",
    description: "Your AI applies to internships while you sleep.",
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
        {children}
        <Script id="sw-register" strategy="afterInteractive">{`
          if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
              navigator.serviceWorker.register('/sw.js');
            });
          }
        `}</Script>
      </body>
    </html>
  );
}

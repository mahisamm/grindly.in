import type { Metadata } from "next";
import { Orbitron, Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Body — warm humanist grotesque (replaces the default Geist)
const bodySans = Hanken_Grotesk({
  variable: "--ff-sans",
  subsets: ["latin"],
  display: "swap",
});

// Code / data — replaces Geist Mono
const codeMono = JetBrains_Mono({
  variable: "--ff-mono",
  subsets: ["latin"],
  display: "swap",
});

// Display — robotic/sci-fi geometric for headlines + wordmark (agent does the work)
const displayFont = Orbitron({
  variable: "--ff-display",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "NexPath — your AI applies to internships while you sleep",
  description:
    "NexPath reads your resume, finds matching internships, and auto-applies for you. Daily progress updates over Slack.",
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
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

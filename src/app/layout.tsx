import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Prevent pinch-zoom / double-tap zoom from fighting the game's touch controls.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "The Sonar Room — Audio as Graphics",
  description:
    "You are blind. Navigate a pitch-black maze entirely through echolocation: click to ping, WASD to move, find 3 keys and reach the exit before the monster finds you.",
  keywords: ["sonar", "echolocation", "horror game", "audio game", "Next.js", "canvas"],
  authors: [{ name: "aman-sanin" }],
  icons: {
    icon: "/logo.svg",
  },
  openGraph: {
    title: "The Sonar Room",
    description: "Navigate the dark with sound. Find 3 keys. Don't let it find you.",
    siteName: "The Sonar Room",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}

import type { ReactNode } from "react";
import type { Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Space_Grotesk } from "next/font/google";
import { MotionProvider } from "@/components/MotionProvider";
import { ToastProvider } from "@/components/overlays/Toast";
import "./globals.css";

const display = Space_Grotesk({ subsets: ["latin"], weight: ["600", "700"], variable: "--font-space-grotesk", display: "swap" });

export const metadata = { title: "chat-lite" };
// The on-screen keyboard shrinks the layout viewport (and so 100dvh) instead of sliding over the page, which keeps the
// composer above it on Android; iOS Safari ignores this and scrolls the focused field into view itself.
export const viewport: Viewport = { interactiveWidget: "resizes-content" };
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} ${display.variable}`}>
      <body>
        <MotionProvider>
          <ToastProvider>{children}</ToastProvider>
        </MotionProvider>
      </body>
    </html>
  );
}

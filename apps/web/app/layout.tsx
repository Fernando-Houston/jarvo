import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HVI — Houston Voice Intelligence",
  description: "Voice-first AI for Houston real estate, grounded in live Harris County records.",
  // PWA: installable to the home screen — required for Web Push on iOS.
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
};

export const viewport = {
  themeColor: "#04080a",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

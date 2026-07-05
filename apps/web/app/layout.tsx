import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HVI — Houston Voice Intelligence",
  description: "Voice-first AI for Houston real estate, grounded in live Harris County records.",
  // PWA: installable to the home screen — required for Web Push on iOS.
  // iOS ignores manifest icons and takes the apple-touch-icon link.
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
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

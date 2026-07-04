import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HVI — Houston Voice Intelligence",
  description: "Voice-first AI for Houston real estate, grounded in live Harris County records.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

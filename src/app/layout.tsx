import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AmbientBackground } from "@/components/ambient/ambient-background";

export const metadata: Metadata = {
  title: "Homelab",
  description: "Ambient homelab operations homepage.",
  // No external icons, manifests, or analytics wired in by default.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#090b10",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <AmbientBackground />
        {children}
      </body>
    </html>
  );
}

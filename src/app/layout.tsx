import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Platinum Labs",
  description: "Platinum Labs",
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
      {/* V2: the topology itself is the visual interest — the background stays
          a flat near-black with only a faint vignette (globals.css). */}
      <body className="topology-ground">{children}</body>
    </html>
  );
}

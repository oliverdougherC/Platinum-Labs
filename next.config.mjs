/** @type {import('next').NextConfig} */

/**
 * Application security headers (PLA-193).
 *
 * The dashboard serves only its own first-party assets — no remote fonts,
 * scripts, analytics, or beacons — so the policy is tight:
 *  - `default-src 'self'` and `connect-src 'self'` (the browser only ever calls
 *    /api/dashboard on the same origin; connector base URLs are server-side only,
 *    so no browser request can turn the server into a proxy).
 *  - `img-src 'self' data:` for inline data-URI chart/media placeholders.
 *  - `frame-ancestors 'none'` + `X-Frame-Options: DENY` — never embeddable.
 *  - `'unsafe-inline'` is permitted for script/style only: Next's App Router
 *    bootstrap and Recharts' inline SVG styling require it, and a private
 *    LAN/Tailscale deployment is the V1 trust boundary (documented in the README
 *    security section). Everything else is locked to 'self'.
 */
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

const nextConfig = {
  reactStrictMode: true,
  // Standalone output for a minimal production Docker image (PLA-196).
  output: "standalone",
  // No external analytics or telemetry by default. Next.js telemetry is
  // additionally disabled via the `NEXT_TELEMETRY_DISABLED` env in .env.example
  // and CI. Keep the runtime free of third-party beacons.
  poweredByHeader: false,
  // Native addon: must not be bundled into the server build (PLA-179).
  serverExternalPackages: ["better-sqlite3"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;

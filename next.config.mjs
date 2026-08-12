/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // No external analytics or telemetry by default. Next.js telemetry is
  // additionally disabled via the `NEXT_TELEMETRY_DISABLED` env in .env.example
  // and CI. Keep the runtime free of third-party beacons.
  poweredByHeader: false,
  // Native addon: must not be bundled into the server build (PLA-179).
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;

import { getDataMode } from "@/lib/env.server";

/**
 * Health endpoint (PLA-196) — suitable for Docker/reverse-proxy monitoring.
 *
 * This is a LIVENESS probe: it returns 200 whenever the Node process can serve
 * requests. It deliberately does NOT reflect upstream connector health — a
 * restarting Sonarr must never mark the whole container unhealthy. Per-connector
 * readiness is exposed (informationally) via /api/dashboard's `health[]`.
 *
 * It performs no upstream calls and reads no secrets, so it is cheap and safe to
 * poll frequently.
 */
export const dynamic = "force-dynamic";

const START = Date.now();

export function GET() {
  return Response.json(
    {
      status: "ok",
      mode: safeMode(),
      uptimeSeconds: Math.round((Date.now() - START) / 1000),
      // Deployment provenance: the git SHA baked in at image build time
      // (GIT_SHA build arg), so "what commit is production running?" is
      // answerable from the health endpoint alone.
      revision: process.env.GIT_SHA || "unknown",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

function safeMode(): string {
  try {
    return getDataMode();
  } catch {
    // A config error must not fail liveness — the process is still up.
    return "unknown";
  }
}

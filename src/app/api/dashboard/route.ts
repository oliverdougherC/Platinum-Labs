import type { NextRequest } from "next/server";
import { getDashboardSnapshot } from "@/lib/snapshot.server";

/**
 * Aggregate dashboard state endpoint (PLA-186).
 *
 * The single backend contract the homepage polls. Fake and live modes return
 * the SAME shape. Connector failures are already isolated upstream
 * (`Promise.allSettled` in the hub), so this returns 200 with partial data and
 * per-connector health rather than a 500 — the page never blanks because one
 * service is down. `no-store` keeps it live; upstream polling cadence is owned
 * by the server scheduler, not this request.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const scenario = req.nextUrl.searchParams.get("scenario") ?? undefined;
  try {
    const snapshot = await getDashboardSnapshot({ scenarioOverride: scenario });
    return Response.json(snapshot, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    // Only a total backend failure (e.g. live mode misconfigured) reaches here —
    // connector failures are already isolated upstream. Never send a backend
    // exception message to the browser (it may contain internal paths, a
    // misconfig detail, or a URL with a token): log the sanitized diagnostic
    // server-side and return a generic, stable public error.
    console.error(
      "[api/dashboard] request failed:",
      err instanceof Error ? err.message : String(err),
    );
    return Response.json(
      { error: "Dashboard temporarily unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

import type { NextRequest } from "next/server";
import { getActionRegistry } from "@/lib/actions/actions.server";
import { makeRateLimiter } from "@/lib/rate-limit";

/**
 * Safe action execution endpoint (PLA-192 concepts / PLA-258).
 *
 * The browser may only name a REGISTERED action id and supply that action's
 * validated input — there is no generic forwarding of paths, methods, headers,
 * or URLs. Every failure mode is an explicit, sanitized status; the registry
 * itself guarantees in-flight idempotency for duplicate submissions.
 */
export const dynamic = "force-dynamic";

const limiter = makeRateLimiter({ windowMs: 60_000, max: 12 });

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Lightweight cross-site (CSRF) defense for this privileged write boundary.
 * The dashboard has no cookie session to steal, but the route drives an
 * administrator-capable server-side credential, so browser-originated
 * cross-site invocations are rejected before anything executes:
 *
 *  - the body must be declared `application/json`, so a hostile page cannot
 *    reach the handler with a CORS-safelisted `text/plain` simple request;
 *  - `Sec-Fetch-Site: cross-site` (fetch metadata, sent by modern browsers) is
 *    rejected outright — same-origin/same-site values pass, and the header is
 *    deliberately not *required* because non-browser clients omit it;
 *  - when a browser supplies `Origin`, its host must match the request's own
 *    `Host` (both travel through the same reverse proxy, so this holds for the
 *    production deployment without trusting extra forwarded headers; only the
 *    host is compared because TLS may terminate upstream of the app).
 */
function rejectCrossSite(req: NextRequest): Response | null {
  const contentType = (req.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return Response.json(
      {
        ok: false,
        code: "invalid-content-type",
        message: "Actions require Content-Type: application/json",
      },
      { status: 415, headers: NO_STORE },
    );
  }

  const forbidden = () =>
    Response.json(
      {
        ok: false,
        code: "forbidden",
        message: "Cross-site action requests are not allowed",
      },
      { status: 403, headers: NO_STORE },
    );

  if (req.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site") {
    return forbidden();
  }

  const origin = req.headers.get("origin");
  if (origin !== null) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return forbidden(); // includes the opaque "null" origin
    }
    const selfHost = req.headers.get("host") ?? req.nextUrl.host;
    if (originHost !== selfHost) return forbidden();
  }

  return null;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ action: string }> },
) {
  const rejected = rejectCrossSite(req);
  if (rejected) return rejected;

  if (!limiter.tryAcquire()) {
    return Response.json(
      { ok: false, code: "rate-limited", message: "Too many actions — slow down" },
      { status: 429, headers: NO_STORE },
    );
  }

  const { action } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = undefined; // schema validation reports it as invalid input
  }

  const execution = await getActionRegistry().execute(action, body);
  switch (execution.status) {
    case "unknown-action":
      return Response.json(
        { ok: false, code: "unknown-action", message: "Unknown action" },
        { status: 404, headers: NO_STORE },
      );
    case "invalid-input":
      return Response.json(
        { ok: false, code: "invalid-input", message: "Invalid action input" },
        { status: 400, headers: NO_STORE },
      );
    case "disabled":
      return Response.json(
        { ok: false, code: "disabled", message: execution.reason },
        { status: 503, headers: NO_STORE },
      );
    case "ok": {
      // The action result is the browser payload; a failed outcome (e.g. an
      // unapproved Seerr request) is reported as an upstream failure, never a
      // silent success.
      const failed =
        typeof execution.result === "object" &&
        execution.result !== null &&
        "ok" in execution.result &&
        (execution.result as { ok: unknown }).ok === false;
      return Response.json(execution.result, {
        status: failed ? 502 : 200,
        headers: NO_STORE,
      });
    }
  }
}

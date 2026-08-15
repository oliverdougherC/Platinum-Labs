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

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ action: string }> },
) {
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

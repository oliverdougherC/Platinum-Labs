import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDataMode, getServerEnv } from "@/lib/env.server";
import { resolveSeerr } from "@/lib/seerr/config.server";
import { getSeerrClient } from "@/lib/seerr/client.server";
import { normalizeSearch, type SeerrSearchResult } from "@/lib/seerr/api";
import { fakeSeerrSearch } from "@/lib/seerr/fixtures";
import { sanitizeError } from "@/lib/connectors/connector";
import { makeRateLimiter } from "@/lib/rate-limit";

/**
 * Normalized interactive media search (PLA-257).
 *
 * The one search contract the browser knows: it never sees Seerr's raw API,
 * URL, or credential. Fake and live modes return the same shape. Failures are
 * sanitized and scoped to this endpoint — Seerr downtime disables search, never
 * the dashboard.
 */
export const dynamic = "force-dynamic";

const querySchema = z.object({
  q: z.string().trim().min(2).max(80),
  page: z.coerce.number().int().min(1).max(5).default(1),
});

/** Debounced interactive typing stays well under this; loops do not. */
const limiter = makeRateLimiter({ windowMs: 10_000, max: 30 });

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest) {
  if (!limiter.tryAcquire()) {
    return Response.json(
      { error: "Too many searches — slow down" },
      { status: 429, headers: NO_STORE },
    );
  }

  const parsed = querySchema.safeParse({
    q: req.nextUrl.searchParams.get("q") ?? "",
    page: req.nextUrl.searchParams.get("page") ?? undefined,
  });
  if (!parsed.success) {
    return Response.json(
      { error: "Enter at least 2 characters" },
      { status: 400, headers: NO_STORE },
    );
  }
  const { q, page } = parsed.data;

  if (getDataMode() === "fake") {
    const fake = fakeSeerrSearch(q);
    if (fake.kind === "unavailable") {
      return Response.json(
        { error: "Seerr is unreachable" },
        { status: 502, headers: NO_STORE },
      );
    }
    return Response.json({ results: fake.results }, { headers: NO_STORE });
  }

  const resolved = resolveSeerr(getServerEnv());
  if (resolved.kind !== "configured") {
    return Response.json(
      { error: "Media search is not configured" },
      { status: 503, headers: NO_STORE },
    );
  }

  let results: SeerrSearchResult[];
  try {
    results = normalizeSearch(await getSeerrClient(resolved.value).search(q, page));
  } catch (err) {
    // Sanitized: never the URL, key, or upstream body.
    return Response.json(
      { error: sanitizeError(err) },
      { status: 502, headers: NO_STORE },
    );
  }
  return Response.json({ results }, { headers: NO_STORE });
}

import type { NextRequest } from "next/server";
import { isValidPosterPath, POSTER_SIZES, type PosterSize } from "@/lib/seerr/api";
import { makeRateLimiter } from "@/lib/rate-limit";

/**
 * Narrow same-origin poster proxy (PLA-256 artwork handling).
 *
 * Seerr returns TMDB poster paths; serving them through this proxy keeps the
 * strict CSP (`img-src 'self'`) and the no-third-party-beacons privacy posture
 * intact — the browser never contacts an external origin. The proxy accepts
 * ONLY a validated `/<hash>.<jpg|png>` path and an allowlisted size, so it can
 * never be steered to an arbitrary URL, and it needs no credential (the TMDB
 * image CDN is public — no metadata API key is added for artwork).
 */
export const dynamic = "force-dynamic";

const POSTER_ORIGIN = "https://image.tmdb.org/t/p";
const TIMEOUT_MS = 8_000;
/** Generous: a full search page renders ~15 posters at once. */
const limiter = makeRateLimiter({ windowMs: 60_000, max: 240 });

export async function GET(req: NextRequest) {
  if (!limiter.tryAcquire()) {
    return new Response(null, { status: 429 });
  }

  const size = req.nextUrl.searchParams.get("size") ?? "";
  const path = req.nextUrl.searchParams.get("path") ?? "";
  if (!(POSTER_SIZES as readonly string[]).includes(size) || !isValidPosterPath(path)) {
    return new Response(null, { status: 400 });
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(`${POSTER_ORIGIN}/${size as PosterSize}${path}`, {
      signal: ac.signal,
      // Let Next's data cache hold poster bytes; they are immutable per path.
      cache: "force-cache",
    });
  } catch {
    return new Response(null, { status: 502 });
  } finally {
    clearTimeout(timer);
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  if (!upstream.ok || !contentType.startsWith("image/")) {
    return new Response(null, { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": contentType,
      // Poster content is immutable per path; cache hard in the browser.
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
    },
  });
}

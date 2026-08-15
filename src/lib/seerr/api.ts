/**
 * Seerr / Jellyseerr domain contract (PLA-256/257) — pure and isomorphic.
 *
 * Follows the connector convention (jellyfin.ts): lenient Zod schemas for the
 * upstream `/api/v1` payloads, pure normalizers that map validated data to a
 * minimal UI-safe shape, and no network or `server-only` imports so everything
 * is unit-testable against fixtures. The server-only HTTP client lives in
 * `client.server.ts`; the browser only ever sees the normalized types below.
 */

import { z } from "zod";
import { parseUpstream } from "@/lib/connectors/validate";

// --- normalized (UI-safe) types ---------------------------------------------

export type SeerrMediaType = "movie" | "tv";

/**
 * Stable dashboard request/library state derived from Seerr `mediaInfo.status`.
 * `requestable` means Seerr knows of no existing request or library entry.
 */
export type SeerrMediaState =
  | "requestable"
  | "pending"
  | "processing"
  | "partial"
  | "available";

export interface SeerrSearchResult {
  /** TMDB id — the `mediaId` a request action submits back. */
  id: number;
  mediaType: SeerrMediaType;
  title: string;
  /** Release year (movie) or first-air year (TV), when known. */
  year: number | null;
  /** TMDB poster path (e.g. "/abc123.jpg"); rendered via the same-origin proxy. */
  posterPath: string | null;
  /** Short overview for disambiguation; truncated server-side. */
  overview: string | null;
  state: SeerrMediaState;
}

/**
 * Browser-safe feature availability (resolved server-side in config.server.ts).
 * Never includes URLs or secrets — this shape is passed to client components.
 */
export interface SeerrAvailability {
  search: boolean;
  requests: boolean;
}

/** Outcome of the request action, as reported to the browser. */
export type SeerrRequestOutcome =
  /** A new request was created (or found pending) and confirmed APPROVED. */
  | { ok: true; outcome: "approved"; title: string }
  /** Seerr already tracks this media; nothing was created. Stable, not an error. */
  | { ok: true; outcome: "already-requested"; state: SeerrMediaState; title: string }
  | {
      ok: false;
      code: "approval-failed" | "request-failed" | "unavailable" | "disabled";
      message: string;
    };

// --- upstream enums ----------------------------------------------------------

/** Seerr MediaInfo.status values (`/api/v1` MediaStatus). */
export const MEDIA_STATUS = {
  UNKNOWN: 1,
  PENDING: 2,
  PROCESSING: 3,
  PARTIALLY_AVAILABLE: 4,
  AVAILABLE: 5,
} as const;

/** Seerr MediaRequest.status values (`/api/v1` MediaRequestStatus). */
export const REQUEST_STATUS = {
  PENDING: 1,
  APPROVED: 2,
  DECLINED: 3,
  FAILED: 4,
} as const;

/**
 * Map Seerr `mediaInfo.status` to the dashboard state. A missing mediaInfo or
 * UNKNOWN means never requested. Unrecognized future values map to
 * `processing` (non-requestable) so the dashboard can never double-request
 * media in a state it does not understand.
 */
export function mapMediaStatus(status: number | undefined): SeerrMediaState {
  switch (status) {
    case undefined:
    case MEDIA_STATUS.UNKNOWN:
      return "requestable";
    case MEDIA_STATUS.PENDING:
      return "pending";
    case MEDIA_STATUS.PROCESSING:
      return "processing";
    case MEDIA_STATUS.PARTIALLY_AVAILABLE:
      return "partial";
    case MEDIA_STATUS.AVAILABLE:
      return "available";
    default:
      return "processing";
  }
}

// --- upstream schemas (lenient: tolerate the many fields we don't use) -------

const mediaInfoSchema = z
  .object({ status: z.number().optional() })
  .passthrough();

const searchResultSchema = z
  .object({
    id: z.number(),
    mediaType: z.string(),
    // movie naming
    title: z.string().optional(),
    releaseDate: z.string().optional().nullable(),
    // tv naming
    name: z.string().optional(),
    firstAirDate: z.string().optional().nullable(),
    posterPath: z.string().optional().nullable(),
    overview: z.string().optional().nullable(),
    mediaInfo: mediaInfoSchema.optional().nullable(),
  })
  .passthrough();

export const seerrSearchPageSchema = z
  .object({
    page: z.number().optional(),
    totalPages: z.number().optional(),
    results: z.array(searchResultSchema),
  })
  .passthrough();

/** `POST /request` and `POST /request/{id}/approve` both return a MediaRequest. */
export const seerrMediaRequestSchema = z
  .object({
    id: z.number(),
    status: z.number(),
    media: mediaInfoSchema.optional().nullable(),
  })
  .passthrough();

const seasonSchema = z
  .object({
    seasonNumber: z.number(),
    episodeCount: z.number().optional(),
  })
  .passthrough();

const mediaInfoSeasonSchema = z
  .object({
    seasonNumber: z.number(),
    status: z.number().optional(),
  })
  .passthrough();

/** `GET /movie/{id}` and `GET /tv/{id}` — only the fields the action needs. */
export const seerrMovieDetailsSchema = z
  .object({
    id: z.number(),
    title: z.string().optional(),
    mediaInfo: mediaInfoSchema.optional().nullable(),
  })
  .passthrough();

export const seerrTvDetailsSchema = z
  .object({
    id: z.number(),
    name: z.string().optional(),
    seasons: z.array(seasonSchema).optional(),
    mediaInfo: mediaInfoSchema
      .extend({ seasons: z.array(mediaInfoSeasonSchema).optional() })
      .optional()
      .nullable(),
  })
  .passthrough();

export type SeerrTvDetails = z.infer<typeof seerrTvDetailsSchema>;
export type SeerrMovieDetails = z.infer<typeof seerrMovieDetailsSchema>;
export type SeerrMediaRequest = z.infer<typeof seerrMediaRequestSchema>;

// --- normalization (pure) ----------------------------------------------------

const OVERVIEW_MAX_CHARS = 240;

function yearOf(date: string | null | undefined): number | null {
  if (!date) return null;
  const year = Number(date.slice(0, 4));
  return Number.isInteger(year) && year > 1800 ? year : null;
}

function truncateOverview(overview: string | null | undefined): string | null {
  const text = overview?.trim();
  if (!text) return null;
  if (text.length <= OVERVIEW_MAX_CHARS) return text;
  return `${text.slice(0, OVERVIEW_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * Validate and normalize a raw `/api/v1/search` page into UI-safe results.
 * Person results (and anything else that is not movie/tv) are dropped here.
 */
export function normalizeSearch(data: unknown): SeerrSearchResult[] {
  const page = parseUpstream(seerrSearchPageSchema, data, "seerr.search");
  const results: SeerrSearchResult[] = [];
  for (const raw of page.results) {
    if (raw.mediaType !== "movie" && raw.mediaType !== "tv") continue;
    const isMovie = raw.mediaType === "movie";
    const title = (isMovie ? raw.title : raw.name)?.trim();
    if (!title) continue;
    results.push({
      id: raw.id,
      mediaType: raw.mediaType,
      title,
      year: yearOf(isMovie ? raw.releaseDate : raw.firstAirDate),
      posterPath: normalizePosterPath(raw.posterPath),
      overview: truncateOverview(raw.overview),
      state: mapMediaStatus(raw.mediaInfo?.status ?? undefined),
    });
  }
  return results;
}

/**
 * Season numbers of a TV series that Seerr does not already track (no request
 * and no library entry): the safe set for a duplicate-free one-click request.
 * Specials (season 0) and empty placeholder seasons are excluded, matching
 * Seerr's own default request surface.
 */
export function missingSeasonNumbers(details: SeerrTvDetails): number[] {
  const tracked = new Map<number, number>();
  for (const s of details.mediaInfo?.seasons ?? []) {
    tracked.set(s.seasonNumber, s.status ?? MEDIA_STATUS.UNKNOWN);
  }
  return (details.seasons ?? [])
    .filter((s) => s.seasonNumber > 0 && (s.episodeCount ?? 0) > 0)
    .map((s) => s.seasonNumber)
    .filter((n) => {
      const status = tracked.get(n);
      return status === undefined || status === MEDIA_STATUS.UNKNOWN;
    });
}

// --- poster handling (shared by the proxy route and the UI) ------------------

/**
 * TMDB poster paths as returned by Seerr: `/<hash>.<jpg|png>`. Anything else is
 * rejected so the same-origin proxy can never be steered to an arbitrary URL.
 */
const POSTER_PATH_RE = /^\/[A-Za-z0-9]+\.(?:jpg|jpeg|png)$/;

export const POSTER_SIZES = ["w92", "w154", "w185", "w342", "w500"] as const;
export type PosterSize = (typeof POSTER_SIZES)[number];

export function isValidPosterPath(path: string): boolean {
  return POSTER_PATH_RE.test(path);
}

/** Normalize an upstream poster path, dropping anything unexpected. */
export function normalizePosterPath(
  path: string | null | undefined,
): string | null {
  if (!path) return null;
  return isValidPosterPath(path) ? path : null;
}

/** Same-origin proxy URL for a poster (see /api/seerr/poster). */
export function posterProxyUrl(path: string, size: PosterSize = "w185"): string {
  return `/api/seerr/poster?size=${size}&path=${encodeURIComponent(path)}`;
}

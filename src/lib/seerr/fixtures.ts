/**
 * Deterministic Seerr fixtures for fake mode (PLA-256/259).
 *
 * Extends the fake-data system (PLA-177) to the interactive search/request
 * feature so the full UX — every media state and every request outcome — can be
 * developed, reviewed, and tested without a live Seerr instance. Pure and
 * deterministic: the same query always yields the same results, no I/O.
 *
 * Conventions, chosen to be easy to exercise by hand:
 *  - search matches fixture titles by case-insensitive substring;
 *  - searching "offline" simulates Seerr being unreachable;
 *  - a fixture's REQUEST OUTCOME is encoded by its id's last digit:
 *      …1 → create returns APPROVED immediately
 *      …2 → create returns pending, explicit approval succeeds
 *      …3 → create returns pending, approval FAILS (surfaces as failure)
 *      …4 → create call itself fails
 *    (anything else behaves like …1). Titles note non-default behaviors.
 */

import type {
  SeerrMediaState,
  SeerrRequestOutcome,
  SeerrSearchResult,
} from "@/lib/seerr/api";

export const OFFLINE_QUERY = "offline";

interface Fixture extends SeerrSearchResult {}

function fixture(
  id: number,
  mediaType: "movie" | "tv",
  title: string,
  year: number,
  state: SeerrMediaState,
  overview: string,
): Fixture {
  return { id, mediaType, title, year, posterPath: null, overview, state };
}

/**
 * A representative mixed catalog. Poster paths stay null so fake mode never
 * makes a network request (the UI's placeholder rendering is exercised
 * instead).
 */
const CATALOG: Fixture[] = [
  fixture(
    101,
    "movie",
    "The Martian",
    2015,
    "requestable",
    "An astronaut becomes stranded on Mars and must improvise to survive.",
  ),
  fixture(
    202,
    "movie",
    "Arrival (approves via fallback)",
    2016,
    "requestable",
    "A linguist races to decode an alien language. Fake mode: create returns pending, then explicit approval succeeds.",
  ),
  fixture(
    303,
    "movie",
    "Blade Runner 2049 (approval fails)",
    2017,
    "requestable",
    "A young blade runner unearths a long-buried secret. Fake mode: approval fallback fails.",
  ),
  fixture(
    404,
    "movie",
    "Tenet (request fails)",
    2020,
    "requestable",
    "Armed with only one word, a protagonist fights for survival. Fake mode: request creation fails.",
  ),
  fixture(
    511,
    "movie",
    "Dune: Part Two",
    2024,
    "available",
    "Paul Atreides unites with the Fremen while seeking revenge.",
  ),
  fixture(
    621,
    "movie",
    "Sinners",
    2025,
    "processing",
    "Twin brothers return to their hometown to start again.",
  ),
  fixture(
    731,
    "movie",
    "Mickey 17",
    2025,
    "pending",
    "An expendable employee is sent to colonize an ice world.",
  ),
  fixture(
    111,
    "tv",
    "Foundation",
    2021,
    "requestable",
    "A band of exiles works to preserve civilization against a falling empire.",
  ),
  fixture(
    212,
    "tv",
    "Severance (approves via fallback)",
    2022,
    "requestable",
    "Employees split their memories between work and home. Fake mode: create returns pending, then explicit approval succeeds.",
  ),
  fixture(
    322,
    "tv",
    "Andor",
    2022,
    "partial",
    "The story of the Rebellion told through Cassian Andor. Some seasons are already available; Request adds the missing ones.",
  ),
  fixture(
    432,
    "tv",
    "The Bear",
    2022,
    "pending",
    "A young chef returns to run his family's sandwich shop.",
  ),
  fixture(
    542,
    "tv",
    "Shrinking",
    2023,
    "processing",
    "A grieving therapist starts telling his patients exactly what he thinks.",
  ),
  fixture(
    652,
    "tv",
    "The Studio",
    2025,
    "available",
    "A newly promoted studio head navigates the movie business.",
  ),
];

export type FakeSearchResult =
  | { kind: "ok"; results: SeerrSearchResult[] }
  | { kind: "unavailable" };

/** Deterministic fake search over the fixture catalog. */
export function fakeSeerrSearch(query: string): FakeSearchResult {
  const q = query.trim().toLowerCase();
  if (q === OFFLINE_QUERY) return { kind: "unavailable" };
  return {
    kind: "ok",
    results: CATALOG.filter((f) => f.title.toLowerCase().includes(q)),
  };
}

/**
 * Deterministic fake request outcome, following the same create → inspect →
 * approve-fallback → verify semantics as the real action (see request.ts).
 */
export function fakeSeerrRequest(
  mediaType: "movie" | "tv",
  mediaId: number,
): SeerrRequestOutcome {
  const known = CATALOG.find((f) => f.id === mediaId && f.mediaType === mediaType);
  const title = known?.title ?? `${mediaType} ${mediaId}`;

  // Pre-existing non-requestable state collapses to the stable outcome, except
  // partial TV, where Request adds the missing seasons.
  if (known && known.state !== "requestable" && known.state !== "partial") {
    return { ok: true, outcome: "already-requested", state: known.state, title };
  }

  switch (mediaId % 10) {
    case 3:
      return {
        ok: false,
        code: "approval-failed",
        message:
          "Request created but approval could not be confirmed — it may be waiting for manual approval in Seerr",
      };
    case 4:
      return { ok: false, code: "request-failed", message: "Seerr returned HTTP 500" };
    default:
      // …1 (immediate approval) and …2 (explicit fallback) both end APPROVED.
      return { ok: true, outcome: "approved", title };
  }
}

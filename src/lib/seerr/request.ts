/**
 * Seerr media-request orchestration (PLA-256/258) — pure, injected-client.
 *
 * Implements the critical product contract: a dashboard-created request is
 * successful ONLY once Seerr has confirmed it APPROVED. The create response is
 * never trusted to imply auto-approval; if it comes back pending, the approval
 * endpoint is invoked explicitly and the result re-verified. A request left
 * pending is a failure, full stop.
 *
 * Once APPROVED, this action's responsibility ends: whatever the operator's
 * Seerr/Radarr/Sonarr configuration does next (automatic search, downloads) is
 * downstream behavior that the existing acquisition connectors observe
 * independently. Nothing here requires or triggers it.
 *
 * The Seerr client is injected (like the connector normalizers' `http`), so the
 * whole flow — payload shape, approval fallback, duplicate handling — is
 * unit-tested without network or `server-only` imports.
 */

import { ConnectorError, sanitizeError } from "@/lib/connectors/connector";
import { parseUpstream } from "@/lib/connectors/validate";
import {
  REQUEST_STATUS,
  mapMediaStatus,
  missingSeasonNumbers,
  seerrMediaRequestSchema,
  seerrMovieDetailsSchema,
  seerrTvDetailsSchema,
  type SeerrMediaType,
  type SeerrRequestOutcome,
} from "@/lib/seerr/api";
import type { SeerrClient, SeerrRequestPayload } from "@/lib/seerr/client.server";

// A type-only import keeps this module free of `server-only` at runtime.
type SeerrHttpErrorLike = ConnectorError & { status: number };

function httpStatusOf(err: unknown): number | null {
  if (
    err instanceof ConnectorError &&
    "status" in err &&
    typeof (err as SeerrHttpErrorLike).status === "number"
  ) {
    return (err as SeerrHttpErrorLike).status;
  }
  return null;
}

export interface SeerrRequestInput {
  mediaType: SeerrMediaType;
  mediaId: number;
}

/** Media identity + title/state resolved server-side before creating a request. */
interface ResolvedMedia {
  title: string;
  state: ReturnType<typeof mapMediaStatus>;
  /** TV only: seasons safe to request without duplicating existing requests. */
  missingSeasons: number[] | null;
  /** TV only: whether the missing set covers every requestable season. */
  allSeasonsMissing: boolean;
}

async function resolveMedia(
  client: SeerrClient,
  input: SeerrRequestInput,
): Promise<ResolvedMedia> {
  if (input.mediaType === "movie") {
    const details = parseUpstream(
      seerrMovieDetailsSchema,
      await client.movieDetails(input.mediaId),
      "seerr.movie",
    );
    return {
      title: details.title?.trim() || `movie ${input.mediaId}`,
      state: mapMediaStatus(details.mediaInfo?.status ?? undefined),
      missingSeasons: null,
      allSeasonsMissing: false,
    };
  }

  const details = parseUpstream(
    seerrTvDetailsSchema,
    await client.tvDetails(input.mediaId),
    "seerr.tv",
  );
  const missing = missingSeasonNumbers(details);
  const requestable = (details.seasons ?? []).filter(
    (s) => s.seasonNumber > 0 && (s.episodeCount ?? 0) > 0,
  ).length;
  return {
    title: details.name?.trim() || `series ${input.mediaId}`,
    state: mapMediaStatus(details.mediaInfo?.status ?? undefined),
    missingSeasons: missing,
    allSeasonsMissing: missing.length > 0 && missing.length === requestable,
  };
}

/**
 * Create a Seerr request and confirm it APPROVED.
 *
 * Flow: resolve media (title + current state, and for TV the duplicate-free
 * season set) → create → inspect returned status → explicitly approve when not
 * already approved → verify APPROVED → success. Pre-existing requests and
 * upstream duplicate (409) responses collapse to a stable `already-requested`
 * outcome instead of an error.
 */
export async function performSeerrRequest(
  client: SeerrClient,
  input: SeerrRequestInput,
): Promise<SeerrRequestOutcome> {
  let media: ResolvedMedia;
  try {
    media = await resolveMedia(client, input);
  } catch (err) {
    return { ok: false, code: "unavailable", message: sanitizeError(err) };
  }

  // Already fully tracked: a truthful stable state, not an error. Partially
  // available TV with missing seasons continues — that is the explicit
  // "request missing seasons" path.
  const tvHasMissing =
    input.mediaType === "tv" && (media.missingSeasons?.length ?? 0) > 0;
  if (media.state !== "requestable" && !tvHasMissing) {
    return {
      ok: true,
      outcome: "already-requested",
      state: media.state,
      title: media.title,
    };
  }

  const payload: SeerrRequestPayload = {
    mediaType: input.mediaType,
    mediaId: input.mediaId,
  };
  if (input.mediaType === "tv") {
    // Default one-click behavior: every season. When Seerr already tracks some
    // seasons, request only the missing ones so nothing is duplicated.
    payload.seasons = media.allSeasonsMissing ? "all" : media.missingSeasons!;
  }

  let created;
  try {
    created = parseUpstream(
      seerrMediaRequestSchema,
      await client.createRequest(payload),
      "seerr.request",
    );
  } catch (err) {
    if (httpStatusOf(err) === 409) {
      // Raced with another request (or Seerr considers it a duplicate).
      return {
        ok: true,
        outcome: "already-requested",
        state: media.state === "requestable" ? "pending" : media.state,
        title: media.title,
      };
    }
    return { ok: false, code: "request-failed", message: sanitizeError(err) };
  }

  if (created.status === REQUEST_STATUS.APPROVED) {
    return { ok: true, outcome: "approved", title: media.title };
  }

  // Not auto-approved: invoke the approval endpoint explicitly and verify.
  // This is a hard postcondition — a request left pending is a failure.
  try {
    const approved = parseUpstream(
      seerrMediaRequestSchema,
      await client.approveRequest(created.id),
      "seerr.approve",
    );
    if (approved.status !== REQUEST_STATUS.APPROVED) {
      throw new ConnectorError("Seerr did not confirm the request as approved");
    }
  } catch (err) {
    return {
      ok: false,
      code: "approval-failed",
      message: `Request created but approval could not be confirmed — it may be waiting for manual approval in Seerr (${sanitizeError(err)})`,
    };
  }

  return { ok: true, outcome: "approved", title: media.title };
}

import "server-only";

import { z } from "zod";
import { getDataMode, getServerEnv } from "@/lib/env.server";
import { ActionRegistry } from "@/lib/actions/registry";
import { resolveSeerr } from "@/lib/seerr/config.server";
import { getSeerrClient } from "@/lib/seerr/client.server";
import { performSeerrRequest } from "@/lib/seerr/request";
import { fakeSeerrRequest } from "@/lib/seerr/fixtures";
import { tryPersist } from "@/lib/db/db.server";
import { insertActivityEvent, insertAudit } from "@/lib/db/repository";
import type { SeerrRequestOutcome } from "@/lib/seerr/api";
import type { ActivityEvent } from "@/lib/types";

/**
 * Process-wide safe action registry wiring (PLA-192 concepts / PLA-258).
 *
 * Registers the narrow set of write operations the dashboard offers — currently
 * exactly one: `seerr.request`. The registry supplies allowlisting, input
 * validation, enablement gating, and in-flight idempotency; this module adds
 * the live/fake split and audit + activity persistence, which stay out of the
 * pure modules so they remain unit-testable.
 */

export const SEERR_REQUEST_ACTION_ID = "seerr.request";

/** Minimal trusted input: the browser identifies media, nothing else. It can
 * never supply Seerr routing (serverId/profileId/rootFolder/userId), seasons,
 * paths, or headers — those are server-side decisions. */
const seerrRequestInput = z
  .object({
    mediaType: z.enum(["movie", "tv"]),
    mediaId: z.number().int().positive().max(2_147_483_647),
  })
  .strict();

type SeerrRequestInput = z.infer<typeof seerrRequestInput>;

function seerrDisabledReason(): string | null {
  if (getDataMode() === "fake") return null;
  const resolved = resolveSeerr(getServerEnv());
  if (resolved.kind === "absent") return "Seerr is not configured";
  if (resolved.kind === "partial") return "Seerr is misconfigured";
  if (!resolved.value.requestsEnabled) return "Seerr requests are disabled";
  return null;
}

/** Persist the request outcome to the activity feed (live mode only — fake
 * mode's feed is fixture-driven and must stay free of real persistence). */
function persistOutcome(input: SeerrRequestInput, outcome: SeerrRequestOutcome): void {
  if (getDataMode() === "fake") return;

  const at = Date.now();
  const subject = `${input.mediaType}:${input.mediaId}`;
  let event: ActivityEvent | null = null;
  if (outcome.ok && outcome.outcome === "approved") {
    event = {
      id: `request.approved:${subject}:${at}`,
      at,
      kind: "request.approved",
      severity: "info",
      source: "seerr",
      message: `Requested and approved: ${outcome.title}`,
      subject,
    };
  } else if (!outcome.ok && outcome.code !== "disabled") {
    // Meaningful failures only; messages are already sanitized upstream.
    event = {
      id: `request.failed:${subject}:${at}`,
      at,
      kind: "request.failed",
      severity: "warning",
      source: "seerr",
      message: `Media request failed: ${outcome.message}`,
      subject,
    };
  }

  tryPersist((db) => {
    if (event) insertActivityEvent(db, event);
    insertAudit(db, at, SEERR_REQUEST_ACTION_ID, auditLine(input, outcome));
  });
}

function auditLine(input: SeerrRequestInput, outcome: SeerrRequestOutcome): string {
  const subject = `${input.mediaType}:${input.mediaId}`;
  if (outcome.ok) {
    return outcome.outcome === "approved"
      ? `approved ${subject}`
      : `already-requested ${subject} (${outcome.state})`;
  }
  return `failed ${subject} (${outcome.code})`;
}

function buildRegistry(): ActionRegistry {
  const registry = new ActionRegistry();

  registry.register<SeerrRequestInput, SeerrRequestOutcome>({
    id: SEERR_REQUEST_ACTION_ID,
    input: seerrRequestInput,
    disabledReason: seerrDisabledReason,
    dedupeKey: (input) => `${input.mediaType}:${input.mediaId}`,
    async handler(input) {
      let outcome: SeerrRequestOutcome;
      if (getDataMode() === "fake") {
        outcome = fakeSeerrRequest(input.mediaType, input.mediaId);
      } else {
        const resolved = resolveSeerr(getServerEnv());
        if (resolved.kind !== "configured") {
          // Config changed between the gate and the run — fail cleanly.
          outcome = {
            ok: false,
            code: "disabled",
            message: "Seerr is not configured",
          };
        } else {
          outcome = await performSeerrRequest(getSeerrClient(resolved.value), input);
        }
      }
      persistOutcome(input, outcome);
      return outcome;
    },
    auditResult: (outcome) =>
      outcome.ok ? outcome.outcome : `failed:${outcome.code}`,
  });

  return registry;
}

let registry: ActionRegistry | null = null;

export function getActionRegistry(): ActionRegistry {
  if (!registry) registry = buildRegistry();
  return registry;
}

/** Test-only: rebuild the registry (e.g. after env changes). */
export function __resetActionRegistryForTests(): void {
  registry = null;
}

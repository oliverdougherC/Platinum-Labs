import "server-only";

import { getDataMode, getServerEnv, type ServerEnv } from "@/lib/env.server";
import type { SeerrAvailability } from "@/lib/seerr/api";

export type { SeerrAvailability };

/**
 * Seerr / Jellyseerr configuration resolution (PLA-256/257).
 *
 * Seerr is an *interactive* integration (search and request on demand), not a
 * polled connector, so it resolves here instead of joining the connector hub.
 * The same three-state model as `connectors/config.server.ts` applies: absent,
 * configured, or partial (half-configured is an explicit misconfiguration).
 *
 * Legacy `JELLYSEERR_URL` / `JELLYSEERR_API_KEY` are accepted as aliases for
 * operators still on a compatible Jellyseerr instance; each field falls back
 * independently, and `SEERR_*` always wins when both are set. Error strings
 * name the missing field(s) only and never echo a secret value.
 */

export interface SeerrConfig {
  url: string;
  apiKey: string;
  /** Whether the request (write) action is enabled; search is independent. */
  requestsEnabled: boolean;
}

export type ResolvedSeerr =
  | { kind: "configured"; value: SeerrConfig }
  | { kind: "absent" }
  | { kind: "partial"; error: string };

export function resolveSeerr(env: ServerEnv): ResolvedSeerr {
  const url = env.SEERR_URL ?? env.JELLYSEERR_URL;
  const apiKey = env.SEERR_API_KEY ?? env.JELLYSEERR_API_KEY;

  if (url === undefined && apiKey === undefined) return { kind: "absent" };
  if (url === undefined || apiKey === undefined) {
    const missing = url === undefined ? "SEERR_URL" : "SEERR_API_KEY";
    return {
      kind: "partial",
      error: `incomplete configuration — missing ${missing}`,
    };
  }
  return {
    kind: "configured",
    value: { url, apiKey, requestsEnabled: env.SEERR_REQUESTS_ENABLED },
  };
}

/**
 * Resolve browser-safe feature availability. In fake mode the deterministic
 * fixtures stand in for a live Seerr, so both capabilities are on.
 */
export function getSeerrAvailability(): SeerrAvailability {
  let env: ServerEnv;
  try {
    env = getServerEnv();
  } catch {
    return { search: false, requests: false };
  }

  if (getDataMode() === "fake") return { search: true, requests: true };

  const resolved = resolveSeerr(env);
  if (resolved.kind === "partial") {
    // Sanitized (names the missing field only, never a secret value).
    console.warn(`[config] seerr: ${resolved.error}`);
  }
  if (resolved.kind !== "configured") return { search: false, requests: false };
  return { search: true, requests: resolved.value.requestsEnabled };
}

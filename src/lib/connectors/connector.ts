/**
 * Normalized connector framework — core contract (PLA-178).
 *
 * Every real service (Jellyfin, Sonarr, Radarr, qBittorrent, ZFS) implements
 * this small interface. The framework around it (runtime.ts, hub.ts) adds
 * timeouts, overlap protection, last-known-good caching, health/staleness, and
 * failure isolation so one bad service can never break the aggregate.
 *
 * Server-only concerns (secrets, network) live inside `poll`; the returned
 * snapshot `T` is always normalized and secret-free.
 */

import type { ConnectorHealth, ConnectorId } from "@/lib/types";

export interface Connector<T> {
  readonly id: ConnectorId;
  /** Poll interval in ms; the scheduler/cache uses this to pace refreshes. */
  readonly pollIntervalMs: number;
  /**
   * Fetch and normalize a fresh snapshot. Must honor `signal` (abort on
   * timeout) and throw a (sanitized) error on failure — never return partial or
   * secret-bearing data.
   */
  poll(signal: AbortSignal): Promise<T>;
}

/** A connector's current runtime state: last-known-good snapshot + health. */
export interface ConnectorState<T> {
  /** Last successful snapshot, retained across failures. Null until first success. */
  snapshot: T | null;
  health: ConnectorHealth;
}

/**
 * Base class for errors that are safe to surface to clients. `poll`
 * implementations should throw these (or the framework will substitute a
 * generic message) so upstream secrets never leak into `health.lastError`.
 */
export class ConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorError";
  }
}

export class ConnectorTimeoutError extends ConnectorError {
  constructor(ms: number) {
    super(`Timed out after ${ms}ms`);
    this.name = "ConnectorTimeoutError";
  }
}

/** Thrown by validators when upstream JSON fails its schema. */
export class ConnectorValidationError extends ConnectorError {
  constructor(detail: string) {
    super(`Malformed upstream response: ${detail}`);
    this.name = "ConnectorValidationError";
  }
}

/** Map an unknown thrown value to a client-safe message (never leaks secrets). */
export function sanitizeError(err: unknown): string {
  if (err instanceof ConnectorError) return err.message;
  // Deliberately generic for unknown errors — upstream detail may contain a URL
  // with an api_key query param, a token in a header echo, etc.
  return "Upstream request failed";
}

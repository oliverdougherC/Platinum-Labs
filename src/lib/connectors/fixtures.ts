/**
 * Deterministic connector fixtures for framework tests (PLA-178).
 *
 * These implement the same `Connector<T>` contract as real services and let the
 * runtime/hub tests prove fan-out isolation, timeouts, malformed-data handling,
 * failure→recovery, and staleness without any network. Secret-free.
 */

import { z } from "zod";
import { ConnectorError, type Connector } from "@/lib/connectors/connector";
import { parseUpstream } from "@/lib/connectors/validate";
import type { ConnectorId } from "@/lib/types";

export interface Ping {
  ok: true;
  value: number;
}

/** Always succeeds with a fixed payload. */
export function healthyConnector(
  id: ConnectorId = "jellyfin",
  value = 1,
): Connector<Ping> {
  return {
    id,
    pollIntervalMs: 10_000,
    async poll() {
      return { ok: true, value };
    },
  };
}

/** Always throws a client-safe error. */
export function failingConnector(id: ConnectorId = "sonarr"): Connector<Ping> {
  return {
    id,
    pollIntervalMs: 10_000,
    async poll() {
      throw new ConnectorError("service returned HTTP 503");
    },
  };
}

/** Throws an error whose message contains a secret, to test sanitization. */
export function leakyConnector(id: ConnectorId = "radarr"): Connector<Ping> {
  return {
    id,
    pollIntervalMs: 10_000,
    async poll() {
      // A non-ConnectorError with a secret in the message.
      throw new Error("GET http://host/api?apikey=SUPERSECRET failed");
    },
  };
}

/** Never resolves before the timeout, but honors the abort signal. */
export function hangingConnector(id: ConnectorId = "qbittorrent"): Connector<Ping> {
  return {
    id,
    pollIntervalMs: 10_000,
    poll(signal) {
      return new Promise<Ping>((_, reject) => {
        signal.addEventListener("abort", () =>
          reject(new ConnectorError("aborted")),
        );
      });
    },
  };
}

const pingSchema = z.object({ ok: z.literal(true), value: z.number() });

/** Runs upstream data through Zod; feed it junk to trigger validation errors. */
export function validatingConnector(
  upstream: unknown,
  id: ConnectorId = "zfs",
): Connector<Ping> {
  return {
    id,
    pollIntervalMs: 10_000,
    async poll() {
      return parseUpstream(pingSchema, upstream, "ping");
    },
  };
}

/** Fails for the first `failFor` polls, then succeeds — for recovery tests. */
export function flakyConnector(
  failFor: number,
  id: ConnectorId = "jellyfin",
): Connector<Ping> {
  let calls = 0;
  return {
    id,
    pollIntervalMs: 10_000,
    async poll() {
      calls += 1;
      if (calls <= failFor) throw new ConnectorError("temporary failure");
      return { ok: true, value: calls };
    },
  };
}

/** Counts how many times poll is entered — for overlap tests. */
export function countingSlowConnector(id: ConnectorId = "jellyfin"): {
  connector: Connector<Ping>;
  entries: () => number;
  release: () => void;
} {
  let entries = 0;
  let releaseFn: (() => void) | null = null;
  const connector: Connector<Ping> = {
    id,
    pollIntervalMs: 10_000,
    poll() {
      entries += 1;
      return new Promise<Ping>((resolve) => {
        releaseFn = () => resolve({ ok: true, value: entries });
      });
    },
  };
  return {
    connector,
    entries: () => entries,
    release: () => releaseFn?.(),
  };
}

import "server-only";

import { fetchJson } from "@/lib/connectors/http";
import { parseUpstream } from "@/lib/connectors/validate";
import type { Connector } from "@/lib/connectors/connector";
import {
  hostCollectorSchema,
  normalizeHostTelemetry,
  type RawHostSample,
} from "@/lib/telemetry/normalize";
import type { HostTelemetrySnapshot } from "@/lib/types";

/**
 * Host telemetry collector (PLA-265) — `server-only`.
 *
 * Fetches raw cumulative counters from the collector sidecar's `/v1/host`
 * endpoint and normalizes rate domains against the previous sample. The
 * closure keeps only two raw samples (prev + curr) plus the last normalized
 * snapshot — bounded by construction.
 */
export function makeHostCollect(
  url: string,
  token: string | undefined,
): (signal: AbortSignal) => Promise<HostTelemetrySnapshot> {
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  let prevRaw: RawHostSample | null = null;
  let prevSnapshot: HostTelemetrySnapshot | null = null;
  return async (signal) => {
    const raw = await fetchJson(url, { signal, headers, label: "host" });
    const sample = parseUpstream(hostCollectorSchema, raw, "host.collector");
    const snapshot = normalizeHostTelemetry(prevRaw, sample, prevSnapshot);
    prevRaw = sample;
    prevSnapshot = snapshot;
    return snapshot;
  };
}

export function createHostConnector(
  cfg: { pollIntervalMs: number },
  collect: (signal: AbortSignal) => Promise<HostTelemetrySnapshot>,
): Connector<HostTelemetrySnapshot> {
  return {
    id: "host",
    pollIntervalMs: cfg.pollIntervalMs,
    poll: (signal) => collect(signal),
  };
}

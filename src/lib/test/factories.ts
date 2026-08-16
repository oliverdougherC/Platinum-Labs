/**
 * Shared test factories for the extended domain types (PLA-264/265), so unit
 * tests can keep constructing minimal pools/snapshots without repeating the
 * physical/logical capacity plumbing.
 */

import { emptyTelemetry } from "@/lib/telemetry/normalize";
import type { HostTelemetrySnapshot, ZfsPool } from "@/lib/types";

/**
 * Build a full `ZfsPool` from headline used/total numbers. Physical mirrors the
 * headline values (as if RAIDZ overhead were zero) unless overridden — fine for
 * tests that only exercise thresholds/health/scrub logic.
 */
export function testPool(
  overrides: Partial<ZfsPool> & { name?: string } = {},
): ZfsPool {
  const usedBytes = overrides.usedBytes ?? 95;
  const totalBytes = overrides.totalBytes ?? 100;
  const capacityFraction =
    overrides.capacityFraction ?? (totalBytes > 0 ? usedBytes / totalBytes : 0);
  return {
    name: "tank",
    usedBytes,
    totalBytes,
    capacityFraction,
    capacityBasis: "logical",
    allocation: {
      sizeBytes: totalBytes,
      allocBytes: usedBytes,
      freeBytes: totalBytes - usedBytes,
      capFraction: capacityFraction,
      fragPercent: null,
    },
    logical: {
      usedBytes,
      availBytes: totalBytes - usedBytes,
      totalBytes,
      usedFraction: capacityFraction,
    },
    health: "ONLINE",
    scan: "none",
    lastScrubAt: null,
    scrubErrors: 0,
    ...overrides,
  };
}

/** All-unavailable telemetry for snapshot literals in tests. */
export function testTelemetry(): HostTelemetrySnapshot {
  return emptyTelemetry();
}

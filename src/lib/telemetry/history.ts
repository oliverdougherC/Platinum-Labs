/**
 * Bounded rolling telemetry histories (PLA-265). Pure and allocation-light:
 * push returns the same array mutated in place, hard-capped at `cap` points —
 * this page runs 24/7 and no history may grow unbounded.
 */

import type { TelemetryHistory, TelemetryHistoryPoint } from "@/lib/types";

/** ~6 minutes at the 2s host cadence. */
export const HISTORY_CAP = 180;

export function pushBounded(
  series: TelemetryHistoryPoint[],
  point: TelemetryHistoryPoint,
  cap = HISTORY_CAP,
): TelemetryHistoryPoint[] {
  series.push(point);
  if (series.length > cap) series.splice(0, series.length - cap);
  return series;
}

export function emptyTelemetryHistory(): TelemetryHistory {
  return { cpuTotal: [], netRx: [], netTx: [], diskRead: [], diskWrite: [] };
}

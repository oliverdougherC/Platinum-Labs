export type GaugeTelemetryStatus =
  | "available"
  | "stale"
  | "unavailable"
  | "not-configured";

export function gaugePercent(fraction: number | null): number | null {
  if (fraction === null || !Number.isFinite(fraction) || fraction < 0) return null;
  return Math.round(Math.min(1, fraction) * 100);
}

export function gaugeUtilizationLabel(
  status: GaugeTelemetryStatus,
  percent: number | null,
): string {
  if (status === "stale") return "stale";
  if (status !== "available" || percent === null) return "—";
  return `${percent}%`;
}

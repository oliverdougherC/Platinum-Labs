/**
 * Small isomorphic helpers. Kept dependency-free for the scaffold; a fuller
 * class-merge utility (clsx + tailwind-merge) can be adopted in PLA-173 if the
 * primitive set grows to need conflict resolution.
 */

export type ClassValue = string | number | null | false | undefined;

/** Join truthy class fragments into a single className string. */
export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}

/** Human-readable bytes, e.g. 1536 -> "1.5 KB". */
export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / Math.pow(1024, exponent);
  const digits = exponent === 0 ? 0 : fractionDigits;
  return `${value.toFixed(digits)} ${units[exponent]}`;
}

/** Bytes/sec as a rate string, e.g. "4.2 MB/s". */
export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** Clamp a number to the inclusive [min, max] range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Format a 0..1 fraction as a whole-number percentage string. */
export function formatPercent(fraction: number, fractionDigits = 0): string {
  return `${(clamp(fraction, 0, 1) * 100).toFixed(fractionDigits)}%`;
}

const SECOND = 1000;
const MINUTE_MS = 60 * SECOND;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Compact relative time, e.g. "just now", "18m ago", "3h ago", "5d ago". */
export function formatRelativeTime(at: number, now: number = Date.now()): string {
  const delta = Math.max(0, now - at);
  if (delta < 45 * SECOND) return "just now";
  if (delta < HOUR_MS) return `${Math.round(delta / MINUTE_MS)}m ago`;
  if (delta < DAY_MS) return `${Math.round(delta / HOUR_MS)}h ago`;
  return `${Math.round(delta / DAY_MS)}d ago`;
}

/** Compact duration from seconds, e.g. "45s", "18m", "1h 20m". */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "—";
  const s = Math.round(totalSeconds);
  if (s < 60) return `${s}s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`;
}

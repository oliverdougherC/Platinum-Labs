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

/**
 * Deterministic, one-way opaque id from an arbitrary string (cyrb53, 53-bit).
 *
 * Used to turn a torrent infohash into a stable dashboard/correlation id WITHOUT
 * exposing the raw infohash to the browser. Not cryptographic — a 53-bit fold is
 * enough to be non-reversible in practice and collision-safe for a homelab-sized
 * set of transfers. Isomorphic and dependency-free.
 */
export function opaqueId(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(36);
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

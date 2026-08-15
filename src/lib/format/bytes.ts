/**
 * The single byte-formatting layer (PLA-264).
 *
 * Every user-facing byte value flows through here. The previous implementation
 * divided by 1024 while labeling with decimal units ("TB"), which — combined
 * with raw `zpool` SIZE being treated as usable capacity — produced the
 * deployed "87.3 TB" for a pool whose real logical capacity is 69.6 TB
 * (95,983,929,131,008 B raw physical = 87.30 TiB — a TiB number wearing a TB
 * label).
 *
 * Rules encoded here:
 *  - decimal units (kB/MB/GB/TB) divide by 1000 and NEVER get an "i".
 *  - binary units (KiB/MiB/GiB/TiB) divide by 1024 and ALWAYS get an "i".
 *  - a TiB value is never labeled TB, mechanically: the unit string is derived
 *    from the divisor inside one function.
 *
 * Isomorphic and dependency-free.
 */

export type ByteUnitSystem = "decimal" | "binary";

const DECIMAL_UNITS = ["B", "kB", "MB", "GB", "TB", "PB"] as const;
const BINARY_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

export interface FormatBytesOptions {
  /** decimal (SI, ×1000) or binary (IEC, ×1024). Default decimal. */
  system?: ByteUnitSystem;
  /** Fraction digits for scaled values (default 1). Bytes always show 0. */
  digits?: number;
}

export interface ScaledBytes {
  value: number;
  unit: string;
  system: ByteUnitSystem;
}

/** Scale a byte count into the largest sensible unit of the chosen system. */
export function scaleBytes(
  bytes: number,
  system: ByteUnitSystem = "decimal",
): ScaledBytes | null {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  const base = system === "decimal" ? 1000 : 1024;
  const units = system === "decimal" ? DECIMAL_UNITS : BINARY_UNITS;
  if (bytes === 0) return { value: 0, unit: units[0]!, system };
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(base)),
    units.length - 1,
  );
  return { value: bytes / Math.pow(base, exponent), unit: units[exponent]!, system };
}

/**
 * Human-readable bytes. Decimal by default ("1.5 MB" = 1,500,000 B); pass
 * `system: "binary"` for IEC units ("1.4 MiB"). Negative/non-finite → "—".
 */
export function formatBytes(bytes: number, opts: FormatBytesOptions = {}): string {
  const scaled = scaleBytes(bytes, opts.system ?? "decimal");
  if (scaled === null) return "—";
  const digits = scaled.unit === "B" ? 0 : opts.digits ?? 1;
  return `${scaled.value.toFixed(digits)} ${scaled.unit}`;
}

/** Bytes/sec as a decimal rate string, e.g. "4.2 MB/s". */
export function formatRate(bytesPerSecond: number, digits = 1): string {
  const scaled = scaleBytes(bytesPerSecond, "decimal");
  if (scaled === null) return "—";
  const d = scaled.unit === "B" ? 0 : digits;
  return `${scaled.value.toFixed(d)} ${scaled.unit}/s`;
}

/**
 * Bits/sec from a bytes/sec value, for network-style displays ("120 Mb/s").
 * Decimal by convention.
 */
export function formatBitRate(bytesPerSecond: number, digits = 0): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return "—";
  const bits = bytesPerSecond * 8;
  const units = ["b", "kb", "Mb", "Gb", "Tb"];
  if (bits === 0) return "0 b/s";
  const exponent = Math.min(
    Math.floor(Math.log(bits) / Math.log(1000)),
    units.length - 1,
  );
  const value = bits / Math.pow(1000, exponent);
  return `${value.toFixed(exponent === 0 ? 0 : digits)} ${units[exponent]}/s`;
}

/**
 * Storage-capacity pair, always decimal, always same unit for both numbers:
 * "60.4 / 69.6 TB". Used + total are scaled by the TOTAL's unit so the pair
 * reads as one measurement.
 */
export function formatCapacityPair(
  usedBytes: number,
  totalBytes: number,
  digits = 1,
): string {
  const total = scaleBytes(totalBytes, "decimal");
  if (total === null || !Number.isFinite(usedBytes) || usedBytes < 0) return "—";
  const divisor = total.value > 0 ? totalBytes / total.value : 1;
  const used = divisor > 0 ? usedBytes / divisor : 0;
  return `${used.toFixed(digits)} / ${total.value.toFixed(digits)} ${total.unit}`;
}

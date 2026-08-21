import { describe, expect, it } from "vitest";
import {
  formatBitRate,
  formatBytes,
  formatCapacityPair,
  formatMemoryBytes,
  formatRate,
  scaleBytes,
} from "@/lib/format/bytes";

/**
 * Live p910 audit values (2026-08-15), used as regression anchors so the
 * TB/TiB confusion that shipped in V1 cannot recur:
 *   DataStore zpool SIZE  = 95,983,929,131,008 B  → 96.0 TB decimal, 87.3 TiB
 *   DataStore root USED   = 60,405,816,351,744 B
 *   DataStore root AVAIL  =  9,195,068,204,032 B  → logical total 69.6 TB
 *   eSATA zpool SIZE      = 32,006,096,289,792 B  → 32.0 TB decimal, 29.1 TiB
 */
const DATASTORE_SIZE = 95_983_929_131_008;
const DATASTORE_USED = 60_405_816_351_744;
const DATASTORE_AVAIL = 9_195_068_204_032;
const ESATA_SIZE = 32_006_096_289_792;

describe("formatBytes — decimal vs binary semantics", () => {
  it("formats decimal TB with a TB label (the V1 regression)", () => {
    // V1 displayed this exact byte count as "87.3 TB" (binary math, decimal
    // label). Decimal formatting must say 96.0 TB.
    expect(formatBytes(DATASTORE_SIZE)).toBe("96.0 TB");
  });

  it("formats binary TiB with a TiB label, never TB", () => {
    const out = formatBytes(DATASTORE_SIZE, { system: "binary" });
    expect(out).toBe("87.3 TiB");
    expect(out).not.toContain(" TB");
  });

  it("matches the eSATA audit pair", () => {
    expect(formatBytes(ESATA_SIZE)).toBe("32.0 TB");
    expect(formatBytes(ESATA_SIZE, { system: "binary" })).toBe("29.1 TiB");
  });

  it("never produces a decimal label from binary scaling (mechanical check)", () => {
    for (const bytes of [1, 1024, 5_000_000, DATASTORE_SIZE, ESATA_SIZE]) {
      const scaled = scaleBytes(bytes, "binary");
      expect(scaled).not.toBeNull();
      if (scaled!.unit !== "B") expect(scaled!.unit).toMatch(/i?B$/);
      if (scaled!.unit.length === 2) {
        // Two-letter units (kB…PB) are decimal-only; binary must be 3 letters.
        throw new Error(`binary scaling produced decimal unit ${scaled!.unit}`);
      }
    }
  });

  it("handles small and edge values", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1000)).toBe("1.0 kB");
    expect(formatBytes(1024, { system: "binary" })).toBe("1.0 KiB");
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatMemoryBytes — familiar primary memory labels", () => {
  it("keeps recognizable memory magnitudes without IEC labels", () => {
    expect(formatMemoryBytes(128 * 1024 ** 3, 0)).toBe("128 GB");
    expect(formatMemoryBytes(44.7 * 1024 ** 3)).toBe("44.7 GB");
    expect(formatMemoryBytes(846.1 * 1024 ** 2)).toBe("846.1 MB");
  });

  it("does not alter the decimal storage convention", () => {
    expect(formatBytes(69.6 * 1000 ** 4)).toBe("69.6 TB");
  });

  it("preserves invalid and zero semantics", () => {
    expect(formatMemoryBytes(0)).toBe("0 B");
    expect(formatMemoryBytes(-1)).toBe("—");
    expect(formatMemoryBytes(Number.NaN)).toBe("—");
  });
});

describe("formatCapacityPair", () => {
  it("renders the corrected DataStore logical headline", () => {
    const logicalTotal = DATASTORE_USED + DATASTORE_AVAIL;
    expect(formatCapacityPair(DATASTORE_USED, logicalTotal)).toBe(
      "60.4 / 69.6 TB",
    );
  });

  it("keeps both numbers in the total's unit", () => {
    // 500 GB used of 2 TB total: used must not switch to GB.
    expect(formatCapacityPair(500_000_000_000, 2_000_000_000_000)).toBe(
      "0.5 / 2.0 TB",
    );
  });

  it("handles zero and invalid input", () => {
    expect(formatCapacityPair(0, 0)).toBe("0.0 / 0.0 B");
    expect(formatCapacityPair(-1, 100)).toBe("—");
    expect(formatCapacityPair(Number.NaN, 100)).toBe("—");
  });
});

describe("rates", () => {
  it("formats decimal rates", () => {
    expect(formatRate(4_200_000)).toBe("4.2 MB/s");
    expect(formatRate(0)).toBe("0 B/s");
    expect(formatRate(-5)).toBe("—");
  });

  it("formats bit rates", () => {
    expect(formatBitRate(15_000_000)).toBe("120 Mb/s");
    expect(formatBitRate(0)).toBe("0 b/s");
    expect(formatBitRate(-1)).toBe("—");
  });
});

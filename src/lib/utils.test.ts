import { describe, expect, it } from "vitest";
import {
  clamp,
  formatBytes,
  formatDuration,
  formatPercent,
  formatRate,
  formatRelativeTime,
} from "@/lib/utils";

describe("formatBytes", () => {
  it("formats zero and small values", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
  });

  it("scales into KB/MB/GB/TB", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 ** 2)).toBe("1.0 MB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
    expect(formatBytes(2 * 1024 ** 4)).toBe("2.0 TB");
  });

  it("returns an em dash for invalid input", () => {
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});

describe("formatRate", () => {
  it("appends /s", () => {
    expect(formatRate(1024 ** 2)).toBe("1.0 MB/s");
  });
});

describe("clamp", () => {
  it("bounds within range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });
});

describe("formatPercent", () => {
  it("formats and clamps fractions", () => {
    expect(formatPercent(0.5)).toBe("50%");
    expect(formatPercent(1.4)).toBe("100%");
    expect(formatPercent(-0.2)).toBe("0%");
  });
});

describe("formatRelativeTime", () => {
  const now = 1_754_000_000_000;
  it("buckets deltas into human units", () => {
    expect(formatRelativeTime(now, now)).toBe("just now");
    expect(formatRelativeTime(now - 18 * 60_000, now)).toBe("18m ago");
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatRelativeTime(now - 5 * 86_400_000, now)).toBe("5d ago");
  });
  it("never returns a negative/future value", () => {
    expect(formatRelativeTime(now + 10_000, now)).toBe("just now");
  });
  it("is DST/timezone-safe (epoch-delta based, PLA-194)", () => {
    // US spring-forward 2024-03-10: 02:00 → 03:00 local. Two instants exactly one
    // real hour apart across the gap still read "1h ago" — wall-clock skips do not
    // corrupt the elapsed time because the delta is computed on epoch ms.
    const beforeGap = Date.parse("2024-03-10T06:30:00.000Z");
    const afterGap = beforeGap + 3_600_000;
    expect(formatRelativeTime(beforeGap, afterGap)).toBe("1h ago");
    // ~25 real hours across fall-back still buckets to "1d ago".
    const fallBack = Date.parse("2024-11-03T05:00:00.000Z");
    expect(formatRelativeTime(fallBack - 25 * 3_600_000, fallBack)).toBe("1d ago");
  });
});

describe("formatDuration", () => {
  it("formats seconds/minutes/hours", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(18 * 60)).toBe("18m");
    expect(formatDuration(80 * 60)).toBe("1h 20m");
    expect(formatDuration(120 * 60)).toBe("2h");
  });
  it("guards invalid input", () => {
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });
});

import { describe, expect, it } from "vitest";
import {
  buildContainerTooltip,
  formatContainerUptime,
  placeContainerTooltip,
} from "./container-tooltip";

describe("container tooltip formatting", () => {
  it("preserves Docker core semantics above 100% and uses shared byte units", () => {
    expect(
      buildContainerTooltip({
        name: "Image ML",
        cpuFraction: 1.4,
        memoryBytes: 3_200_000_000,
        uptimeSeconds: 3 * 86_400 + 4 * 3_600,
        freshness: "live",
        unverified: false,
      }),
    ).toEqual({
      name: "Image ML",
      uptime: "3d 4h",
      cpu: "CPU 140.0%",
      memory: "3.2 GB",
    });
  });

  it("distinguishes unknown and stale values from zero", () => {
    expect(
      buildContainerTooltip({
        name: "worker",
        cpuFraction: null,
        memoryBytes: null,
        uptimeSeconds: null,
        freshness: "live",
        unverified: false,
      }),
    ).toMatchObject({ uptime: "unknown", cpu: "CPU unknown", memory: "unknown" });
    expect(
      buildContainerTooltip({
        name: "worker",
        cpuFraction: 0,
        memoryBytes: 0,
        uptimeSeconds: 0,
        freshness: "live",
        unverified: false,
      }),
    ).toMatchObject({ uptime: "<1s", cpu: "CPU 0.0%", memory: "0 B" });
    expect(
      buildContainerTooltip({
        name: "worker",
        cpuFraction: 2,
        memoryBytes: 10_000_000,
        uptimeSeconds: 500,
        freshness: "stale",
        unverified: false,
      }),
    ).toMatchObject({ uptime: "stale", cpu: "CPU stale", memory: "stale" });
  });

  it("formats long runtime compactly", () => {
    expect(formatContainerUptime(45)).toBe("45s");
    expect(formatContainerUptime(18 * 60)).toBe("18m");
    expect(formatContainerUptime(80 * 60)).toBe("1h 20m");
    expect(formatContainerUptime(12 * 86_400 + 5 * 3_600)).toBe("12d 5h");
  });
});

describe("container tooltip placement", () => {
  it("clamps horizontally and flips below when there is no room above", () => {
    const viewport = { w: 320, h: 180 };
    expect(
      placeContainerTooltip({ x: 2, y: 2, w: 10, h: 10 }, viewport),
    ).toEqual({ left: 8, top: 22 });
    expect(
      placeContainerTooltip({ x: 308, y: 150, w: 10, h: 10 }, viewport),
    ).toEqual({ left: 80, top: 68 });
  });
});

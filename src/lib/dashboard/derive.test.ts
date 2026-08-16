import { describe, expect, it } from "vitest";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";
import {
  capacityBand,
  connectorPresentation,
  healthById,
  storageVisualState,
} from "@/lib/dashboard/derive";

const NOW = 1_754_000_000_000;

describe("storageVisualState", () => {
  it("is ambient when pools are healthy", () => {
    expect(storageVisualState(makeFakeSnapshot("idle", NOW))).toBe("ambient");
  });
  it("is attention on a warning", () => {
    expect(storageVisualState(makeFakeSnapshot("zfs-warning", NOW))).toBe(
      "attention",
    );
  });
  it("is attention when a pool is DEGRADED", () => {
    expect(storageVisualState(makeFakeSnapshot("zfs-degraded", NOW))).toBe(
      "attention",
    );
  });
});

describe("connectorPresentation", () => {
  it("ok for a healthy connector", () => {
    const s = makeFakeSnapshot("idle", NOW);
    expect(connectorPresentation(healthById(s.health, "jellyfin"), NOW)).toBe(
      "ok",
    );
  });
  it("unavailable for a failed connector", () => {
    const s = makeFakeSnapshot("connector-unavailable", NOW);
    expect(connectorPresentation(healthById(s.health, "jellyfin"), NOW)).toBe(
      "unavailable",
    );
  });
  it("stale for a degraded connector past its freshness window", () => {
    const s = makeFakeSnapshot("stale", NOW);
    expect(connectorPresentation(healthById(s.health, "qbittorrent"), NOW)).toBe(
      "stale",
    );
  });
  it("unconfigured when the connector is not set up", () => {
    const s = makeFakeSnapshot("unconfigured", NOW);
    expect(connectorPresentation(healthById(s.health, "zfs"), NOW)).toBe(
      "unconfigured",
    );
  });
});

describe("capacityBand", () => {
  it("classifies thresholds", () => {
    expect(capacityBand(0.5)).toBe("ok");
    expect(capacityBand(0.82)).toBe("warning");
    expect(capacityBand(0.95)).toBe("critical");
  });
});

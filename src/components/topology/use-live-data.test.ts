import { describe, expect, it } from "vitest";
import { liveDataIsStale } from "@/components/topology/use-live-data";

describe("live data freshness", () => {
  const now = 100_000;

  it("does not make an old server sample fresh when it arrives late", () => {
    expect(liveDataIsStale(now - 30_000, now - 100, now, false)).toBe(true);
  });

  it("detects a transport that stopped delivering otherwise-fresh samples", () => {
    expect(liveDataIsStale(now - 100, now - 30_000, now, false)).toBe(true);
  });

  it("accepts data only when both sample and receipt are fresh", () => {
    expect(liveDataIsStale(now - 100, now - 100, now, false)).toBe(false);
  });

  it("keeps deterministic frozen review frames out of live freshness gating", () => {
    expect(liveDataIsStale(0, 0, now, true)).toBe(false);
  });
});

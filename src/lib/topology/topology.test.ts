import { describe, expect, it } from "vitest";
import {
  deriveFlows,
  dominantReadPool,
  dominantWritePool,
} from "@/lib/topology/activity";
import {
  arcPath,
  CANVAS_H,
  CANVAS_W,
  CONTAINER_CLUSTER,
  flowPath,
  NETWORK_EDGE,
  SERVICE_NODES,
  STORAGE_BODIES,
  storageBodyFor,
} from "@/lib/topology/layout";
import {
  deadband,
  Ema,
  flowDurationSeconds,
  intensityFromRate,
} from "@/lib/topology/smoothing";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";

const NOW = 1_754_000_000_000;

describe("Ema smoothing", () => {
  it("first sample passes through, later samples converge", () => {
    const ema = new Ema(3_000);
    expect(ema.update(1, 0)).toBe(1);
    const second = ema.update(0, 1_000);
    expect(second).toBeGreaterThan(0.6); // heavily damped after 1/3 tau
    expect(second).toBeLessThan(1);
    // After many taus it converges.
    let v = second;
    for (let t = 2; t <= 20; t++) v = ema.update(0, t * 3_000);
    expect(v).toBeLessThan(0.01);
  });

  it("is time-aware: a large gap converges further than a small one", () => {
    const a = new Ema(3_000);
    a.update(1, 0);
    const small = a.update(0, 500);
    const b = new Ema(3_000);
    b.update(1, 0);
    const large = b.update(0, 9_000);
    expect(large).toBeLessThan(small);
  });
});

describe("intensity mapping", () => {
  it("background noise is exactly zero (deadband)", () => {
    expect(intensityFromRate(0)).toBe(0);
    expect(intensityFromRate(1_024)).toBe(0); // 1 KB/s packet noise
    expect(intensityFromRate(200_000)).toBe(0); // just under the floor
  });

  it("scales logarithmically and caps at 1", () => {
    const low = intensityFromRate(500_000);
    const mid = intensityFromRate(8_000_000);
    const high = intensityFromRate(80_000_000);
    expect(low).toBeGreaterThan(0);
    expect(mid).toBeGreaterThan(low);
    expect(high).toBe(1);
    expect(intensityFromRate(10_000_000_000)).toBe(1);
  });

  it("flow duration stays calm: never faster than 3.5s per cycle", () => {
    expect(flowDurationSeconds(1)).toBeGreaterThanOrEqual(3.5);
    expect(flowDurationSeconds(0.01)).toBeLessThanOrEqual(14);
    expect(flowDurationSeconds(0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("deadband zeroes small values", () => {
    expect(deadband(10, 100)).toBe(0);
    expect(deadband(200, 100)).toBe(200);
  });
});

describe("layout geometry", () => {
  it("keeps every node inside the canvas", () => {
    for (const node of [...SERVICE_NODES.map((s) => ({ c: s.center, r: s.r })), ...STORAGE_BODIES.map((b) => ({ c: b.center, r: b.r }))]) {
      expect(node.c.x - node.r).toBeGreaterThan(0);
      expect(node.c.x + node.r).toBeLessThan(CANVAS_W);
      expect(node.c.y - node.r).toBeGreaterThan(0);
      expect(node.c.y + node.r).toBeLessThan(CANVAS_H);
    }
    expect(CONTAINER_CLUSTER.y).toBeLessThan(CANVAS_H);
    expect(NETWORK_EDGE.yBottom).toBeLessThan(CANVAS_H);
  });

  it("produces a valid path for every flow id", () => {
    for (const id of [
      "ingress-qbittorrent",
      "qbittorrent-sonarr",
      "qbittorrent-radarr",
      "import-datastore",
      "storage-jellyfin",
      "jellyfin-egress",
    ] as const) {
      const d = flowPath(id, "DataStore");
      expect(d).toMatch(/^M /);
      expect(d).toContain("C");
    }
  });

  it("falls back gracefully for unknown pools", () => {
    const body = storageBodyFor("weirdpool", 0);
    expect(body.r).toBeGreaterThan(0);
    expect(flowPath("import-datastore", "weirdpool")).toMatch(/^M /);
  });

  it("arcPath renders fractions and empty for zero", () => {
    expect(arcPath({ x: 0, y: 0 }, 10, 0)).toBe("");
    expect(arcPath({ x: 0, y: 0 }, 10, 0.5)).toContain("A 10 10");
    // Full circle stays a valid single arc (fraction clamped below 1).
    expect(arcPath({ x: 0, y: 0 }, 10, 1)).toContain("A 10 10");
  });
});

describe("deriveFlows — motion only from real state (PLA-267)", () => {
  it("idle scenario produces NO flows", () => {
    expect(deriveFlows(makeFakeSnapshot("idle", NOW), NOW)).toEqual([]);
  });

  it("downloads scenario produces acquisition + import flows, no playback", () => {
    const flows = deriveFlows(makeFakeSnapshot("downloads", NOW), NOW);
    const ids = flows.map((f) => f.id);
    expect(ids).toContain("ingress-qbittorrent");
    expect(ids).toContain("qbittorrent-sonarr");
    expect(ids).toContain("qbittorrent-radarr");
    expect(ids).toContain("import-datastore");
    expect(ids).not.toContain("storage-jellyfin");
    expect(ids).not.toContain("jellyfin-egress");
    for (const f of flows) {
      expect(f.intensity).toBeGreaterThan(0);
      expect(f.intensity).toBeLessThanOrEqual(1);
    }
  });

  it("playback scenario produces storage→jellyfin→egress, no acquisition", () => {
    const flows = deriveFlows(makeFakeSnapshot("direct-play", NOW), NOW);
    const ids = flows.map((f) => f.id);
    expect(ids).toEqual(["storage-jellyfin", "jellyfin-egress"]);
    // Playback reads from the pool actually serving reads (DataStore profile).
    expect(flows[0]!.pool).toBe("DataStore");
  });

  it("a stalled-only queue does not fake download motion", () => {
    const snap = makeFakeSnapshot("stalled", NOW);
    // Remove the one active download, leaving only stalled/failed items.
    const items = snap.acquisition.items.filter((i) => i.state !== "downloading");
    const stalledOnly = {
      ...snap,
      acquisition: {
        items,
        rollup: { ...snap.acquisition.rollup, downloading: 0, aggregateRateBps: 0 },
      },
    };
    const ids = deriveFlows(stalledOnly, NOW).map((f) => f.id);
    expect(ids).not.toContain("ingress-qbittorrent");
  });

  it("suppresses flows from stale sources", () => {
    const snap = makeFakeSnapshot("downloads", NOW);
    const staleHealth = snap.health.map((h) =>
      h.id === "qbittorrent" ? { ...h, lastSuccessAt: NOW - 10 * 60_000 } : h,
    );
    const flows = deriveFlows({ ...snap, health: staleHealth }, NOW);
    expect(flows.map((f) => f.id)).not.toContain("ingress-qbittorrent");
  });

  it("unavailable telemetry does not zero out real imports", () => {
    const snap = makeFakeSnapshot("downloads", NOW);
    const noDisk = {
      ...snap,
      telemetry: {
        ...snap.telemetry,
        disk: { status: "unavailable" as const, updatedAt: null, value: null },
      },
    };
    const importFlow = deriveFlows(noDisk, NOW).find((f) => f.id === "import-datastore");
    expect(importFlow).toBeDefined();
    expect(importFlow!.intensity).toBeGreaterThan(0);
  });
});

describe("dominant pool helpers", () => {
  it("returns null when disk telemetry is unavailable", () => {
    const snap = makeFakeSnapshot("unconfigured", NOW);
    expect(dominantWritePool(snap)).toBeNull();
    expect(dominantReadPool(snap)).toBeNull();
  });

  it("picks the busiest pool under load", () => {
    const snap = makeFakeSnapshot("downloads", NOW);
    expect(dominantWritePool(snap)).toBe("DataStore");
  });
});

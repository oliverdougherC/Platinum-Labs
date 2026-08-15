import { describe, expect, it } from "vitest";
import { deriveFlows, mediaStorageEndpoint } from "@/lib/topology/activity";
import {
  deadband,
  Ema,
  flowDurationSeconds,
  intensityFromRate,
} from "@/lib/topology/smoothing";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";
import type { DashboardSnapshot, PoolIoTelemetry } from "@/lib/types";

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

// --- helpers for adversarial states ------------------------------------------

function withStale(snap: DashboardSnapshot, id: string): DashboardSnapshot {
  return {
    ...snap,
    health: snap.health.map((h) =>
      h.id === id ? { ...h, lastSuccessAt: NOW - 10 * 60_000 } : h,
    ),
  };
}

function withPoolIo(
  snap: DashboardSnapshot,
  pools: PoolIoTelemetry[],
): DashboardSnapshot {
  const disk = snap.telemetry.disk;
  return {
    ...snap,
    telemetry: {
      ...snap.telemetry,
      disk: {
        status: "available",
        updatedAt: NOW,
        value: {
          readBps: pools.reduce((s, p) => s + p.readBps, 0),
          writeBps: pools.reduce((s, p) => s + p.writeBps, 0),
          pools,
        },
      },
    },
  };
  void disk;
}

const ids = (snap: DashboardSnapshot) => deriveFlows(snap, NOW).map((f) => f.id);

describe("deriveFlows — motion only from real state (PLA-267)", () => {
  it("idle scenario produces NO flows", () => {
    expect(deriveFlows(makeFakeSnapshot("idle", NOW), NOW)).toEqual([]);
  });

  it("downloads scenario renders the real pipeline: network → qb → arr → storage", () => {
    const flows = deriveFlows(makeFakeSnapshot("downloads", NOW), NOW);
    const flowIds = flows.map((f) => f.id);
    expect(flowIds).toContain("download:network->qbittorrent");
    expect(flowIds).toContain("handoff:qbittorrent->sonarr");
    expect(flowIds).toContain("handoff:qbittorrent->radarr");
    // Only Sonarr is importing in this fixture — and the import edge starts at
    // SONARR, never at the downloader (PLA-275).
    expect(flowIds).toContain("import:sonarr->pool:DataStore");
    expect(flowIds.filter((id) => id.startsWith("import:radarr"))).toHaveLength(0);
    expect(flowIds.some((id) => id.startsWith("playback"))).toBe(false);
    for (const f of flows) {
      expect(f.intensity).toBeGreaterThan(0);
      expect(f.intensity).toBeLessThanOrEqual(1);
    }
  });

  it("playback scenario produces storage→jellyfin→egress, no acquisition", () => {
    const flows = deriveFlows(makeFakeSnapshot("direct-play", NOW), NOW);
    expect(flows.map((f) => f.id)).toEqual([
      "playback:pool:DataStore->jellyfin",
      "egress:jellyfin->network",
    ]);
  });

  it("a stalled-only queue does not fake download motion", () => {
    const snap = makeFakeSnapshot("stalled", NOW);
    const items = snap.acquisition.items.filter((i) => i.state !== "downloading");
    const stalledOnly = {
      ...snap,
      acquisition: {
        items,
        rollup: { ...snap.acquisition.rollup, downloading: 0, aggregateRateBps: 0 },
      },
    };
    expect(ids(stalledOnly).some((id) => id.startsWith("download"))).toBe(false);
  });

  it("suppresses download + handoffs when qBittorrent is stale", () => {
    const snap = withStale(makeFakeSnapshot("downloads", NOW), "qbittorrent");
    const flowIds = ids(snap);
    expect(flowIds.some((id) => id.startsWith("download"))).toBe(false);
    expect(flowIds.some((id) => id.startsWith("handoff"))).toBe(false);
  });

  it("unavailable disk telemetry does not zero out real imports", () => {
    const snap = makeFakeSnapshot("downloads", NOW);
    const noDisk = {
      ...snap,
      telemetry: {
        ...snap.telemetry,
        disk: { status: "unavailable" as const, updatedAt: null, value: null },
      },
    };
    const importFlow = deriveFlows(noDisk, NOW).find((f) => f.kind === "import");
    expect(importFlow).toBeDefined();
    expect(importFlow!.intensity).toBeGreaterThanOrEqual(0.25);
  });
});

describe("deriveFlows — honest correlations (PLA-275)", () => {
  it("a stale Sonarr suppresses ONLY Sonarr's edges while Radarr stays live", () => {
    const snap = withStale(makeFakeSnapshot("downloads", NOW), "sonarr");
    const flowIds = ids(snap);
    // Sonarr edges gone — including its import, even though items say importing.
    expect(flowIds.some((id) => id.includes("sonarr"))).toBe(false);
    // Radarr's handoff is untouched; the shared download edge is untouched.
    expect(flowIds).toContain("handoff:qbittorrent->radarr");
    expect(flowIds).toContain("download:network->qbittorrent");
  });

  it("a Radarr-only import creates exactly one import edge, from Radarr", () => {
    const snap = makeFakeSnapshot("downloads", NOW);
    const items = snap.acquisition.items.map((i) =>
      i.state === "importing" ? { ...i, source: "radarr" as const } : i,
    );
    const flows = deriveFlows(
      { ...snap, acquisition: { ...snap.acquisition, items } },
      NOW,
    );
    const imports = flows.filter((f) => f.kind === "import");
    expect(imports).toHaveLength(1);
    expect(imports[0]!.id).toBe("import:radarr->pool:DataStore");
  });

  it("unrelated writes on another pool cannot redirect the import target", () => {
    // NVME gets hammered by something unrelated; media pool is DataStore.
    const snap = withPoolIo(makeFakeSnapshot("downloads", NOW), [
      { pool: "DataStore", readBps: 0, writeBps: 1_000_000 },
      { pool: "NVME", readBps: 0, writeBps: 500_000_000 },
    ]);
    const imports = deriveFlows(snap, NOW).filter((f) => f.kind === "import");
    expect(imports).toHaveLength(1);
    expect(imports[0]!.to).toEqual({ kind: "pool", name: "DataStore" });
  });

  it("unrelated reads on another pool cannot redirect the playback source", () => {
    const snap = withPoolIo(makeFakeSnapshot("direct-play", NOW), [
      { pool: "DataStore", readBps: 2_000_000, writeBps: 0 },
      { pool: "eSATA", readBps: 800_000_000, writeBps: 0 },
    ]);
    const playback = deriveFlows(snap, NOW).find((f) => f.kind === "playback");
    expect(playback).toBeDefined();
    expect(playback!.from).toEqual({ kind: "pool", name: "DataStore" });
  });

  it("no declared media pool ⇒ generic storage endpoint, never a guessed pool", () => {
    const snap = { ...makeFakeSnapshot("downloads", NOW), mediaPool: null };
    const heavyIo = withPoolIo(snap, [
      { pool: "NVME", readBps: 0, writeBps: 500_000_000 },
    ]);
    expect(mediaStorageEndpoint(heavyIo)).toEqual({ kind: "storage" });
    const imports = deriveFlows(heavyIo, NOW).filter((f) => f.kind === "import");
    expect(imports).toHaveLength(1);
    expect(imports[0]!.to).toEqual({ kind: "storage" });
  });

  it("a declared pool that does not exist degrades to generic storage", () => {
    const snap = { ...makeFakeSnapshot("direct-play", NOW), mediaPool: "Ghost" };
    expect(mediaStorageEndpoint(snap)).toEqual({ kind: "storage" });
  });

  it("multiple simultaneous workflows stay one flow per edge", () => {
    const snap = makeFakeSnapshot("active", NOW);
    const flows = deriveFlows(snap, NOW);
    const unique = new Set(flows.map((f) => f.id));
    expect(unique.size).toBe(flows.length);
    // Every flow's endpoints are semantically justified kinds.
    for (const f of flows) {
      expect(["download", "handoff", "import", "playback", "egress"]).toContain(f.kind);
    }
  });
});

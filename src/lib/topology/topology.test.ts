import { describe, expect, it } from "vitest";
import {
  deriveFlows,
  downloadStorageEndpoint,
  mediaStorageEndpoint,
  pickHeadlineRate,
  primaryRate,
  type FlowObservation,
} from "@/lib/topology/activity";
import {
  deadband,
  Ema,
  FLOW_DEADBAND_BPS,
  FLOW_WIDTH_MAX,
  intensityFromRate,
  particlePeriodSeconds,
  widthFromRate,
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

describe("throughput → width mapping", () => {
  it("below the deadband there is NO tunnel (exactly zero)", () => {
    expect(widthFromRate(null)).toBe(0);
    expect(widthFromRate(0)).toBe(0);
    expect(widthFromRate(1_024)).toBe(0);
    expect(widthFromRate(FLOW_DEADBAND_BPS - 1)).toBe(0);
  });

  it("is monotonic across the full homelab range", () => {
    const samples = [
      FLOW_DEADBAND_BPS,
      32_000,
      100_000,
      500_000,
      1_000_000,
      5_000_000,
      10_000_000,
      50_000_000,
      100_000_000,
      600_000_000,
      1_250_000_000, // ~10GbE
    ];
    let prev = 0;
    for (const bps of samples) {
      const w = widthFromRate(bps);
      expect(w).toBeGreaterThanOrEqual(prev);
      prev = w;
    }
  });

  it("hits the perceptual anchors: low ≈1.5–2.5, moderate ≈4–7, high ≈9–13", () => {
    expect(widthFromRate(32_000)).toBeGreaterThanOrEqual(1.5);
    expect(widthFromRate(32_000)).toBeLessThanOrEqual(2.5);
    expect(widthFromRate(5_000_000)).toBeGreaterThanOrEqual(4);
    expect(widthFromRate(5_000_000)).toBeLessThanOrEqual(7);
    expect(widthFromRate(100_000_000)).toBeGreaterThanOrEqual(9);
    expect(widthFromRate(100_000_000)).toBeLessThanOrEqual(13);
  });

  it("clamps: a saturated 10GbE link cannot consume the composition", () => {
    expect(widthFromRate(1_250_000_000)).toBeLessThanOrEqual(FLOW_WIDTH_MAX);
    expect(widthFromRate(100_000_000_000)).toBe(FLOW_WIDTH_MAX);
    expect(FLOW_WIDTH_MAX).toBeLessThanOrEqual(13);
  });

  it("intensity scales logarithmically with its own deadband", () => {
    expect(intensityFromRate(0)).toBe(0);
    expect(intensityFromRate(FLOW_DEADBAND_BPS - 1)).toBe(0);
    const low = intensityFromRate(100_000);
    const mid = intensityFromRate(8_000_000);
    expect(low).toBeGreaterThan(0);
    expect(mid).toBeGreaterThan(low);
    expect(intensityFromRate(10_000_000_000)).toBe(1);
  });

  it("particle cadence: one patient packet at low rates, never frantic", () => {
    expect(particlePeriodSeconds(1_000)).toBe(Number.POSITIVE_INFINITY);
    expect(particlePeriodSeconds(20_000)).toBeGreaterThan(4);
    expect(particlePeriodSeconds(500_000_000)).toBeGreaterThanOrEqual(0.5);
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

function withUnavailable(snap: DashboardSnapshot, id: string): DashboardSnapshot {
  return {
    ...snap,
    health: snap.health.map((h) =>
      h.id === id ? { ...h, status: "unavailable" as const } : h,
    ),
  };
}

function withPoolIo(
  snap: DashboardSnapshot,
  pools: PoolIoTelemetry[],
): DashboardSnapshot {
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
}

const flowsOf = (snap: DashboardSnapshot) => deriveFlows(snap, NOW);
const ids = (snap: DashboardSnapshot) => flowsOf(snap).map((f) => f.id);
const byId = (snap: DashboardSnapshot, id: string): FlowObservation | undefined =>
  flowsOf(snap).find((f) => f.id === id);
const byKind = (snap: DashboardSnapshot, kind: FlowObservation["kind"]) =>
  flowsOf(snap).filter((f) => f.kind === kind);

describe("deriveFlows — motion only from real state (PLA-267)", () => {
  it("idle scenario produces NO flows", () => {
    expect(flowsOf(makeFakeSnapshot("idle", NOW))).toEqual([]);
  });

  it("downloads: WAN conduit + storage write + control signals + organizing", () => {
    const flowIds = ids(makeFakeSnapshot("downloads", NOW));
    expect(flowIds).toContain("wan-transfer:network->qbittorrent");
    expect(flowIds).toContain("storage-transfer:qbittorrent->pool:NVME");
    expect(flowIds).toContain("control:sonarr->qbittorrent");
    expect(flowIds).toContain("control:radarr->qbittorrent");
    // Only Sonarr is importing in this fixture — the organizing signal comes
    // from SONARR toward the media pool, and the byte-carrying copy tunnel
    // runs storage→storage, never through the Arr (PLA-275).
    expect(flowIds).toContain("organize:sonarr->pool:DataStore");
    expect(flowIds).toContain("import-copy:pool:NVME->pool:DataStore");
    expect(flowIds.some((id) => id.startsWith("playback"))).toBe(false);
    expect(flowIds.some((id) => id.includes("radarr->pool"))).toBe(false);
  });

  it("the WAN download channel carries the measured qB rate", () => {
    const wan = byId(makeFakeSnapshot("downloads", NOW), "wan-transfer:network->qbittorrent")!;
    expect(wan.plane).toBe("data");
    expect(wan.evidence).toBe("measured");
    expect(wan.freshness).toBe("live");
    const fwd = wan.channels.find((c) => c.direction === "forward")!;
    expect(fwd.role).toBe("ingress");
    expect(fwd.bytesPerSecond).toBe(11_700_000); // 7.5 + 4.2 MB/s fixtures
  });

  it("playback scenario produces storage→jellyfin→egress, no acquisition", () => {
    const flows = flowsOf({
      ...makeFakeSnapshot("direct-play", NOW),
      jellyfinContainer: null,
    });
    expect(flows.map((f) => f.id)).toEqual([
      "playback:pool:DataStore->jellyfin",
      "egress:jellyfin->network",
    ]);
    for (const f of flows) {
      expect(f.plane).toBe("data");
      expect(f.evidence).toBe("derived"); // session bitrate attributed to the path
      expect(f.channels[0]!.bytesPerSecond).toBeCloseTo(38_000_000 / 8, 0);
    }
  });

  it("a stalled-only queue does not fake download motion", () => {
    const snap = makeFakeSnapshot("stalled", NOW);
    const items = snap.acquisition.items.filter((i) => i.state !== "downloading");
    const stalledOnly = {
      ...snap,
      acquisition: {
        items,
        rollup: {
          ...snap.acquisition.rollup,
          downloading: 0,
          aggregateRateBps: 0,
          uploadRateBps: 0,
          seeding: 0,
        },
      },
    };
    expect(ids(stalledOnly).some((id) => id.startsWith("wan-transfer"))).toBe(false);
    expect(ids(stalledOnly).some((id) => id.startsWith("storage-transfer"))).toBe(false);
  });
});

describe("deriveFlows — bidirectional seeding (PLA-267 v2)", () => {
  it("download + seed share ONE conduit with opposite measured channels", () => {
    const snap = makeFakeSnapshot("seeding", NOW);
    const wan = byId(snap, "wan-transfer:network->qbittorrent")!;
    expect(wan.channels).toHaveLength(2);
    const fwd = wan.channels.find((c) => c.direction === "forward")!;
    const rev = wan.channels.find((c) => c.direction === "reverse")!;
    expect(fwd.role).toBe("ingress");
    expect(fwd.bytesPerSecond).toBe(7_500_000);
    expect(rev.role).toBe("egress");
    expect(rev.bytesPerSecond).toBe(5_800_000);
    // And the storage side mirrors it: write in, seed-read out (derived).
    const store = byId(snap, "storage-transfer:qbittorrent->pool:NVME")!;
    expect(store.evidence).toBe("derived");
    expect(store.channels.find((c) => c.direction === "forward")!.role).toBe("write");
    expect(store.channels.find((c) => c.direction === "reverse")!.role).toBe("read");
  });

  it("seed-only traffic keeps one reverse WAN channel and one reverse storage channel", () => {
    const snap = makeFakeSnapshot("seed-only", NOW);
    const wan = byId(snap, "wan-transfer:network->qbittorrent")!;
    expect(wan.channels).toEqual([
      expect.objectContaining({
        direction: "reverse",
        role: "egress",
        bytesPerSecond: 5_800_000,
      }),
    ]);
    const store = byId(snap, "storage-transfer:qbittorrent->pool:NVME")!;
    expect(store.channels).toEqual([
      expect.objectContaining({
        direction: "reverse",
        role: "read",
        bytesPerSecond: 5_800_000,
      }),
    ]);
  });

  it("an UNKNOWN upload rate rides as an explicit nullable channel, never a fabricated rate", () => {
    // V4 final producer audit: active work with an unknown magnitude keeps
    // its direction alive as a null-rate channel with partial aggregate
    // coverage — the earlier behavior (omitting the direction entirely)
    // hid known activity, and rendering any number would fabricate one.
    const snap = makeFakeSnapshot("seeding", NOW);
    const unknownUpload = {
      ...snap,
      acquisition: {
        ...snap.acquisition,
        rollup: { ...snap.acquisition.rollup, uploadRateBps: null },
      },
    };
    const wan = byId(unknownUpload, "wan-transfer:network->qbittorrent")!;
    const reverse = wan.channels.find((c) => c.direction === "reverse");
    expect(reverse).toBeDefined();
    expect(reverse!.bytesPerSecond).toBeNull();
    expect(wan.rate).toMatchObject({ coverage: "partial", unknownContributors: 1 });
  });

  it("seeding with zero seeding count does not invent an upload channel", () => {
    const snap = makeFakeSnapshot("seeding", NOW);
    const none = {
      ...snap,
      acquisition: {
        ...snap.acquisition,
        rollup: { ...snap.acquisition.rollup, seeding: 0 },
      },
    };
    const wan = byId(none, "wan-transfer:network->qbittorrent")!;
    expect(wan.channels.some((c) => c.direction === "reverse")).toBe(false);
  });
});

describe("deriveFlows — control plane vs data plane (PLA-266 v2)", () => {
  it("Arr→downloader is control-plane, state-only, and rate-free — always", () => {
    for (const scenario of ["downloads", "seeding", "active"] as const) {
      const flows = flowsOf(makeFakeSnapshot(scenario, NOW));
      for (const f of flows.filter((x) => x.kind === "control")) {
        expect(f.plane).toBe("control");
        expect(f.evidence).toBe("state-only");
        expect(f.channels.every((c) => c.bytesPerSecond === null)).toBe(true);
        expect(primaryRate(f)).toBeNull();
      }
    }
  });

  it("the downloaded bytes NEVER route through Sonarr/Radarr", () => {
    for (const scenario of ["downloads", "seeding", "importing", "active"] as const) {
      const flows = flowsOf(makeFakeSnapshot(scenario, NOW));
      for (const f of flows.filter((x) => x.plane === "data")) {
        const touchesArr = [f.from, f.to].some(
          (e) => e.kind === "service" && (e.id === "sonarr" || e.id === "radarr"),
        );
        expect(touchesArr, `${f.id} carries data through an Arr`).toBe(false);
      }
    }
  });

  it("organizing is control-plane state-only; the copy tunnel is storage→storage", () => {
    const flows = flowsOf(makeFakeSnapshot("importing", NOW));
    const organize = flows.find((f) => f.kind === "organize")!;
    expect(organize.plane).toBe("control");
    expect(organize.evidence).toBe("state-only");
    expect(organize.from).toEqual({ kind: "service", id: "sonarr" });
    const copy = flows.find((f) => f.kind === "import-copy")!;
    expect(copy.plane).toBe("data");
    expect(copy.evidence).toBe("derived");
    expect(copy.from).toEqual({ kind: "pool", name: "NVME" });
    expect(copy.to).toEqual({ kind: "pool", name: "DataStore" });
  });

  it("carries typed controller attribution from acquisition/import state instead of provenance wording", () => {
    const base = makeFakeSnapshot("downloads", NOW);
    const sonarrOnly: DashboardSnapshot = {
      ...base,
      acquisition: {
        ...base.acquisition,
        items: base.acquisition.items.filter((item) => item.source === "sonarr"),
      },
    };
    const changedWording: DashboardSnapshot = {
      ...sonarrOnly,
      mediaPool: null,
      downloadPool: null,
    };

    expect(byId(sonarrOnly, "wan-transfer:network->qbittorrent")?.controllerServiceId).toBe("sonarr");
    expect(byId(sonarrOnly, "storage-transfer:qbittorrent->pool:NVME")?.controllerServiceId).toBe("sonarr");
    expect(byId(sonarrOnly, "control:sonarr->qbittorrent")?.controllerServiceId).toBe("sonarr");
    expect(byId(sonarrOnly, "organize:sonarr->pool:DataStore")?.controllerServiceId).toBe("sonarr");
    expect(byId(sonarrOnly, "import-copy:pool:NVME->pool:DataStore")?.controllerServiceId).toBe("sonarr");

    const pooled = byId(sonarrOnly, "storage-transfer:qbittorrent->pool:NVME")!;
    const generic = byId(changedWording, "storage-transfer:qbittorrent->storage")!;
    expect(pooled.provenance).not.toBe(generic.provenance);
    expect(generic.controllerServiceId).toBe("sonarr");
    expect(byId(changedWording, "organize:sonarr->storage")?.controllerServiceId).toBe("sonarr");
  });

  it("leaves shared acquisition flows unattributed when both Arr controllers are active", () => {
    const mixed = makeFakeSnapshot("downloads", NOW);
    expect(byId(mixed, "wan-transfer:network->qbittorrent")?.controllerServiceId).toBeUndefined();
    expect(byId(mixed, "storage-transfer:qbittorrent->pool:NVME")?.controllerServiceId).toBeUndefined();
  });
});

describe("deriveFlows — same-pool vs cross-pool imports (PLA-275)", () => {
  it("same-pool import (rename/hardlink) NEVER becomes a bulk transfer tunnel", () => {
    const snap = makeFakeSnapshot("importing", NOW);
    // Declare downloads and media on the SAME pool with heavy write activity:
    // the honest rendering is local organizing, not a copy tunnel.
    const samePool = withPoolIo(
      { ...snap, downloadPool: "DataStore" },
      [{ pool: "DataStore", readBps: 40_000_000, writeBps: 40_000_000 }],
    );
    const flows = flowsOf(samePool);
    expect(flows.some((f) => f.kind === "import-copy")).toBe(false);
    expect(flows.some((f) => f.kind === "organize")).toBe(true);
  });

  it("cross-pool import without destination-write evidence stays state-only", () => {
    const snap = withPoolIo(makeFakeSnapshot("importing", NOW), [
      { pool: "DataStore", readBps: 0, writeBps: 0 }, // no writes arriving
      { pool: "NVME", readBps: 0, writeBps: 0 },
    ]);
    const flows = flowsOf(snap);
    expect(flows.some((f) => f.kind === "import-copy")).toBe(false);
    expect(flows.some((f) => f.kind === "organize")).toBe(true);
  });

  it("cross-pool import without source-read evidence stays state-only", () => {
    const snap = withPoolIo(makeFakeSnapshot("importing", NOW), [
      { pool: "DataStore", readBps: 0, writeBps: 30_000_000 },
      { pool: "NVME", readBps: 0, writeBps: 0 },
    ]);
    const flows = flowsOf(snap);
    expect(flows.some((f) => f.kind === "import-copy")).toBe(false);
    expect(flows.some((f) => f.kind === "organize")).toBe(true);
  });

  it("unrelated writes on another pool cannot fabricate or redirect the copy", () => {
    const snap = withPoolIo(makeFakeSnapshot("importing", NOW), [
      { pool: "DataStore", readBps: 0, writeBps: 0 },
      { pool: "eSATA", readBps: 0, writeBps: 500_000_000 }, // busiest ≠ chosen
    ]);
    expect(flowsOf(snap).some((f) => f.kind === "import-copy")).toBe(false);
  });

  it("unrelated reads on another pool cannot fabricate or redirect the copy", () => {
    const snap = withPoolIo(makeFakeSnapshot("importing", NOW), [
      { pool: "DataStore", readBps: 0, writeBps: 30_000_000 },
      { pool: "NVME", readBps: 0, writeBps: 0 },
      { pool: "eSATA", readBps: 500_000_000, writeBps: 0 },
    ]);
    expect(flowsOf(snap).some((f) => f.kind === "import-copy")).toBe(false);
  });

  it("import evidence scales from the weaker corroborating side only", () => {
    const snap = makeFakeSnapshot("importing", NOW);
    const copy = byId(snap, "import-copy:pool:NVME->pool:DataStore")!;
    const pools = snap.telemetry.disk.value!.pools;
    const sourceRead = pools.find((p) => p.pool === "NVME")!.readBps;
    const destWrite = pools.find((p) => p.pool === "DataStore")!.writeBps;
    expect(copy.channels[0]!.bytesPerSecond).toBe(Math.min(sourceRead, destWrite));
    expect(copy.provenance).toContain("NVME source reads");
    expect(copy.provenance).toContain("DataStore destination writes");
  });

  it("copy rate is capped by the slower corroborating pool leg", () => {
    const snap = withPoolIo(makeFakeSnapshot("importing", NOW), [
      { pool: "NVME", readBps: 18_000_000, writeBps: 0 },
      { pool: "DataStore", readBps: 0, writeBps: 31_000_000 },
    ]);
    const copy = byId(snap, "import-copy:pool:NVME->pool:DataStore")!;
    expect(copy.channels[0]!.bytesPerSecond).toBe(18_000_000);
  });
});

describe("deriveFlows — generic background storage transfer", () => {
  it("derives one named reader→writer pair when disk telemetry shows a unique live copy", () => {
    const snap = withPoolIo(makeFakeSnapshot("idle", NOW), [
      { pool: "Archive", readBps: 28_000_000, writeBps: 0 },
      { pool: "Backup", readBps: 0, writeBps: 34_000_000 },
      { pool: "NVME", readBps: 0, writeBps: 0 },
    ]);
    const flow = byId(snap, "background-transfer:pool:Archive->pool:Backup")!;
    expect(flow.evidence).toBe("derived");
    expect(flow.freshness).toBe("live");
    expect(flow.channels).toEqual([
      expect.objectContaining({
        direction: "forward",
        role: "write",
        bytesPerSecond: 28_000_000,
      }),
    ]);
    expect(flow.rate).toMatchObject({
      knownBytesPerSecond: 28_000_000,
      coverage: "complete",
      evidence: "derived",
      freshness: "live",
    });
  });

  it("reverses the endpoints when the opposite pool is the unique live reader", () => {
    const snap = withPoolIo(makeFakeSnapshot("idle", NOW), [
      { pool: "Archive", readBps: 0, writeBps: 21_000_000 },
      { pool: "Backup", readBps: 17_000_000, writeBps: 0 },
    ]);
    const flow = byKind(snap, "background-transfer")[0]!;
    expect(flow.from).toEqual({ kind: "pool", name: "Backup" });
    expect(flow.to).toEqual({ kind: "pool", name: "Archive" });
    expect(flow.channels[0]!.bytesPerSecond).toBe(17_000_000);
  });

  it("stays quiet when the live reader/writer pair is ambiguous", () => {
    const snap = withPoolIo(makeFakeSnapshot("idle", NOW), [
      { pool: "Archive", readBps: 28_000_000, writeBps: 0 },
      { pool: "Scratch", readBps: 19_000_000, writeBps: 0 },
      { pool: "Backup", readBps: 0, writeBps: 34_000_000 },
    ]);
    expect(byKind(snap, "background-transfer")).toEqual([]);
  });

  it("does not animate for stale, unavailable, zero, or under-deadband disk telemetry", () => {
    const base = withPoolIo(makeFakeSnapshot("idle", NOW), [
      { pool: "Archive", readBps: 28_000_000, writeBps: 0 },
      { pool: "Backup", readBps: 0, writeBps: 34_000_000 },
    ]);
    const staleDisk: DashboardSnapshot = {
      ...base,
      telemetry: {
        ...base.telemetry,
        disk: {
          ...base.telemetry.disk,
          status: "stale",
          updatedAt: NOW - 10 * 60_000,
        },
      },
    };
    const unavailableDisk: DashboardSnapshot = {
      ...base,
      telemetry: {
        ...base.telemetry,
        disk: { status: "unavailable", updatedAt: null, value: null },
      },
    };
    const zero = withPoolIo(makeFakeSnapshot("idle", NOW), [
      { pool: "Archive", readBps: 0, writeBps: 0 },
      { pool: "Backup", readBps: 0, writeBps: 0 },
    ]);
    const underDeadband = withPoolIo(makeFakeSnapshot("idle", NOW), [
      { pool: "Archive", readBps: FLOW_DEADBAND_BPS - 1, writeBps: 0 },
      { pool: "Backup", readBps: 0, writeBps: FLOW_DEADBAND_BPS - 1 },
    ]);
    expect(byKind(staleDisk, "background-transfer")).toEqual([]);
    expect(byKind(unavailableDisk, "background-transfer")).toEqual([]);
    expect(byKind(zero, "background-transfer")).toEqual([]);
    expect(byKind(underDeadband, "background-transfer")).toEqual([]);
  });

  it("lets explicit import-copy own its pools while a separate background pair still coexists", () => {
    const snap = withPoolIo(makeFakeSnapshot("importing", NOW), [
      { pool: "NVME", readBps: 18_000_000, writeBps: 0 },
      { pool: "DataStore", readBps: 0, writeBps: 31_000_000 },
      { pool: "Archive", readBps: 14_000_000, writeBps: 0 },
      { pool: "Backup", readBps: 0, writeBps: 12_000_000 },
    ]);
    expect(byKind(snap, "import-copy")).toHaveLength(1);
    expect(byId(snap, "import-copy:pool:NVME->pool:DataStore")).toBeDefined();
    expect(byKind(snap, "background-transfer")).toHaveLength(1);
    expect(byId(snap, "background-transfer:pool:Archive->pool:Backup")).toBeDefined();
    expect(byId(snap, "background-transfer:pool:NVME->pool:DataStore")).toBeUndefined();
  });
});

describe("deriveFlows — staleness and unavailability (PLA-273)", () => {
  it("a stale qBittorrent yields a FROZEN flow, not a live one, and not silence", () => {
    const snap = withStale(makeFakeSnapshot("downloads", NOW), "qbittorrent");
    const wan = byId(snap, "wan-transfer:network->qbittorrent");
    expect(wan).toBeDefined();
    expect(wan!.freshness).toBe("stale");
    const store = byId(snap, "storage-transfer:qbittorrent->pool:NVME");
    expect(store!.freshness).toBe("stale");
  });

  it("an UNAVAILABLE qBittorrent suppresses its flows entirely", () => {
    const snap = withUnavailable(makeFakeSnapshot("downloads", NOW), "qbittorrent");
    const flowIds = ids(snap);
    expect(flowIds.some((id) => id.startsWith("wan-transfer"))).toBe(false);
    expect(flowIds.some((id) => id.startsWith("storage-transfer"))).toBe(false);
    expect(flowIds.some((id) => id.startsWith("control"))).toBe(false);
  });

  it("a stale Sonarr freezes ONLY Sonarr's edges while Radarr stays live", () => {
    const snap = withStale(makeFakeSnapshot("downloads", NOW), "sonarr");
    const flows = flowsOf(snap);
    const sonarrEdges = flows.filter((f) => f.id.includes("sonarr"));
    expect(sonarrEdges.length).toBeGreaterThan(0);
    for (const f of sonarrEdges) expect(f.freshness).toBe("stale");
    expect(byId(snap, "control:radarr->qbittorrent")!.freshness).toBe("live");
    expect(byId(snap, "wan-transfer:network->qbittorrent")!.freshness).toBe("live");
  });

  it("a stale Arr never launches a live cross-pool copy", () => {
    const snap = withStale(makeFakeSnapshot("importing", NOW), "sonarr");
    expect(flowsOf(snap).some((f) => f.kind === "import-copy")).toBe(false);
  });

  it("unavailable disk telemetry does not kill the organizing signal", () => {
    const snap = makeFakeSnapshot("importing", NOW);
    const noDisk = {
      ...snap,
      telemetry: {
        ...snap.telemetry,
        disk: { status: "unavailable" as const, updatedAt: null, value: null },
      },
    };
    const flows = flowsOf(noDisk);
    expect(flows.some((f) => f.kind === "organize")).toBe(true);
    // …but the copy tunnel needs real corroboration, so it must vanish.
    expect(flows.some((f) => f.kind === "import-copy")).toBe(false);
  });

  it("stale disk telemetry does not claim a live import-copy tunnel", () => {
    const snap = makeFakeSnapshot("importing", NOW);
    const staleDisk = {
      ...snap,
      telemetry: {
        ...snap.telemetry,
        disk: {
          ...snap.telemetry.disk,
          status: "stale" as const,
          updatedAt: NOW - 10 * 60_000,
        },
      },
    };
    const flows = flowsOf(staleDisk);
    expect(flows.some((f) => f.kind === "organize")).toBe(true);
    expect(flows.some((f) => f.kind === "import-copy")).toBe(false);
  });

  it("a Jellyfin session without any supported rate source stays state-only", () => {
    const snap = makeFakeSnapshot("direct-play", NOW);
    const noBitrate = {
      ...snap,
      jellyfinContainer: null,
      jellyfin: {
        ...snap.jellyfin,
        sessions: snap.jellyfin.sessions.map((s) => ({ ...s, rate: null })),
      },
    };
    const playback = byId(noBitrate, "playback:pool:DataStore->jellyfin")!;
    expect(playback.evidence).toBe("state-only");
    expect(playback.channels[0]!.bytesPerSecond).toBeNull();
    expect(primaryRate(playback)).toBeNull();
  });

  it("preserves the known lower bound for partially-known Jellyfin sessions", () => {
    const snap = makeFakeSnapshot("multi-session", NOW);
    const partial = {
      ...snap,
      jellyfinContainer: null,
      jellyfin: {
        ...snap.jellyfin,
        sessions: snap.jellyfin.sessions.map((s, index) =>
          index === 0 ? { ...s, rate: null } : s,
        ),
      },
    };
    const playback = byId(partial, "playback:pool:DataStore->jellyfin")!;
    const egress = byId(partial, "egress:jellyfin->network")!;
    expect(playback.evidence).toBe("derived");
    expect(egress.evidence).toBe("derived");
    expect(playback.channels[0]!.bytesPerSecond).toBe(1_187_500);
    expect(egress.channels[0]!.bytesPerSecond).toBe(1_187_500);
    expect(egress.rate).toMatchObject({
      knownBytesPerSecond: 1_187_500,
      unknownContributors: 1,
      coverage: "partial",
      basis: "jellyfin-session-output",
      evidence: "reported",
    });
  });

  it("aggregates multiple known Jellyfin session rates", () => {
    const snap = makeFakeSnapshot("multi-session", NOW);
    const allKnown = {
      ...snap,
      jellyfinContainer: null,
      jellyfin: {
        ...snap.jellyfin,
        sessions: snap.jellyfin.sessions.map((s, index) => ({
          ...s,
          rate: {
            bytesPerSecond: index === 0 ? 1_000_000 : 2_000_000,
            basis: "jellyfin-session-output" as const,
            evidence: "reported" as const,
          },
        })),
      },
    };
    const playback = byId(allKnown, "playback:pool:DataStore->jellyfin")!;
    expect(playback.evidence).toBe("derived");
    expect(playback.channels[0]!.bytesPerSecond).toBe(3_000_000);
  });

  it("prefers live explicitly mapped container egress and block reads", () => {
    const snap = makeFakeSnapshot("transcode", NOW);
    const egress = byId(snap, "egress:jellyfin->network")!;
    const playback = byId(snap, "playback:pool:DataStore->jellyfin")!;
    expect(egress.evidence).toBe("measured");
    expect(egress.rate).toMatchObject({
      knownBytesPerSecond: 12_000_000,
      basis: "container-egress",
      evidence: "measured",
      coverage: "complete",
      freshness: "live",
    });
    expect(playback.rate).toMatchObject({
      knownBytesPerSecond: 55_000_000,
      basis: "container-block-read",
      evidence: "measured",
    });
  });

  it("uses exact container mapping rather than fuzzy substring matching", () => {
    const snap = {
      ...makeFakeSnapshot("transcode", NOW),
      jellyfinContainer: "jellyfin-not-the-real-container",
    };
    const egress = byId(snap, "egress:jellyfin->network")!;
    expect(egress.rate).toMatchObject({
      knownBytesPerSecond: 1_500_000,
      basis: "jellyfin-session-output",
      evidence: "reported",
    });
  });

  it("retains stale mapped container telemetry as a frozen last-known rate", () => {
    const base = makeFakeSnapshot("transcode", NOW);
    const snap = {
      ...base,
      jellyfin: {
        ...base.jellyfin,
        sessions: base.jellyfin.sessions.map((session) => ({ ...session, rate: null })),
      },
      telemetry: {
        ...base.telemetry,
        docker: { ...base.telemetry.docker, status: "stale" as const },
      },
    };
    const egress = byId(snap, "egress:jellyfin->network")!;
    expect(egress.freshness).toBe("stale");
    expect(egress.rate).toMatchObject({
      knownBytesPerSecond: 12_000_000,
      basis: "container-egress",
      freshness: "stale",
    });
  });

  it("falls back to explicit unknown when mapping and sessions have no rate", () => {
    const base = makeFakeSnapshot("transcode", NOW);
    const snap = {
      ...base,
      jellyfin: {
        ...base.jellyfin,
        sessions: base.jellyfin.sessions.map((session) => ({ ...session, rate: null })),
      },
      telemetry: {
        ...base.telemetry,
        docker: { ...base.telemetry.docker, status: "unavailable" as const, value: null },
      },
    };
    const egress = byId(snap, "egress:jellyfin->network")!;
    expect(egress.evidence).toBe("state-only");
    expect(egress.channels[0]!.bytesPerSecond).toBeNull();
    expect(egress.rate).toMatchObject({
      knownBytesPerSecond: null,
      unknownContributors: 1,
      coverage: "unknown",
      basis: null,
      evidence: null,
    });
  });

  it("labels session-rate storage use as cache-aware attribution", () => {
    const snap = { ...makeFakeSnapshot("direct-play", NOW), jellyfinContainer: null };
    const playback = byId(snap, "playback:pool:DataStore->jellyfin")!;
    expect(playback.rate).toMatchObject({
      basis: "storage-attribution",
      evidence: "derived",
    });
    expect(playback.provenance).toContain("cache and ARC");
  });
});

describe("deriveFlows — declared storage identity only (PLA-275)", () => {
  it("no declared pools ⇒ generic endpoints, never a guessed pool", () => {
    const snap = {
      ...makeFakeSnapshot("downloads", NOW),
      mediaPool: null,
      downloadPool: null,
    };
    const heavyIo = withPoolIo(snap, [
      { pool: "NVME", readBps: 0, writeBps: 500_000_000 },
    ]);
    expect(mediaStorageEndpoint(heavyIo)).toEqual({ kind: "storage" });
    expect(downloadStorageEndpoint(heavyIo)).toEqual({ kind: "storage" });
    const flowIds = ids(heavyIo);
    expect(flowIds).toContain("storage-transfer:qbittorrent->storage");
    expect(flowIds).toContain("organize:sonarr->storage");
    expect(flowIds.every((id) => !id.includes("import-copy"))).toBe(true);
  });

  it("a declared pool that does not exist degrades to generic storage", () => {
    const snap = { ...makeFakeSnapshot("direct-play", NOW), mediaPool: "Ghost" };
    expect(mediaStorageEndpoint(snap)).toEqual({ kind: "storage" });
  });

  it("unrelated reads on another pool cannot redirect the playback source", () => {
    const snap = withPoolIo(makeFakeSnapshot("direct-play", NOW), [
      { pool: "DataStore", readBps: 2_000_000, writeBps: 0 },
      { pool: "eSATA", readBps: 800_000_000, writeBps: 0 },
    ]);
    const playback = flowsOf(snap).find((f) => f.kind === "playback");
    expect(playback).toBeDefined();
    expect(playback!.from).toEqual({ kind: "pool", name: "DataStore" });
  });

  it("multiple simultaneous workflows stay one flow per edge", () => {
    const snap = makeFakeSnapshot("active", NOW);
    const flows = flowsOf(snap);
    const unique = new Set(flows.map((f) => f.id));
    expect(unique.size).toBe(flows.length);
    for (const f of flows) {
      expect([
        "wan-transfer",
        "storage-transfer",
        "import-copy",
        "playback",
        "egress",
        "control",
        "organize",
      ]).toContain(f.kind);
    }
  });

  it("every flow carries provenance and a semantic label for inspection", () => {
    for (const scenario of ["downloads", "seeding", "importing", "active"] as const) {
      for (const f of flowsOf(makeFakeSnapshot(scenario, NOW))) {
        expect(f.provenance.length).toBeGreaterThan(0);
        expect(f.label.length).toBeGreaterThan(0);
      }
    }
  });
});

/** Set the mapped Jellyfin container's measured rates. */
function withJellyfinContainerRates(
  snap: DashboardSnapshot,
  rates: { netTxBps: number | null; blockReadBps: number | null },
): DashboardSnapshot {
  const docker = snap.telemetry.docker;
  return {
    ...snap,
    telemetry: {
      ...snap.telemetry,
      docker: {
        ...docker,
        value: docker.value
          ? {
              ...docker.value,
              containers: docker.value.containers.map((c) =>
                c.name === snap.jellyfinContainer ? { ...c, ...rates } : c,
              ),
            }
          : null,
      },
    },
  };
}

describe("Jellyfin rate precedence — zero windows never erase session evidence (PLA-265/275)", () => {
  it("pickHeadlineRate: positive live container measurement wins", () => {
    const container = {
      knownBytesPerSecond: 5_000_000,
      unknownContributors: 0,
      coverage: "complete" as const,
      basis: "container-egress" as const,
      evidence: "measured" as const,
      freshness: "live" as const,
    };
    const session = {
      knownBytesPerSecond: 4_000_000,
      unknownContributors: 0,
      coverage: "complete" as const,
      basis: "jellyfin-session-output" as const,
      evidence: "reported" as const,
      freshness: "live" as const,
    };
    const picked = pickHeadlineRate(container, session);
    expect(picked.headline).toBe(container);
    expect(picked.supporting).toEqual([]);
  });

  it("pickHeadlineRate: a measured zero window yields to a nonzero session aggregate and is retained", () => {
    const zeroWindow = {
      knownBytesPerSecond: 0,
      unknownContributors: 0,
      coverage: "complete" as const,
      basis: "container-egress" as const,
      evidence: "measured" as const,
      freshness: "live" as const,
    };
    const session = {
      knownBytesPerSecond: 4_750_000,
      unknownContributors: 0,
      coverage: "complete" as const,
      basis: "source-media" as const,
      evidence: "reported" as const,
      freshness: "live" as const,
    };
    const picked = pickHeadlineRate(zeroWindow, session);
    expect(picked.headline).toBe(session);
    expect(picked.supporting).toEqual([zeroWindow]);
  });

  it("pickHeadlineRate: measured zero is the headline only without contradictory evidence", () => {
    const zeroWindow = {
      knownBytesPerSecond: 0,
      unknownContributors: 0,
      coverage: "complete" as const,
      basis: "container-egress" as const,
      evidence: "measured" as const,
      freshness: "live" as const,
    };
    const unknownSession = {
      knownBytesPerSecond: null,
      unknownContributors: 1,
      coverage: "unknown" as const,
      basis: null,
      evidence: null,
      freshness: "live" as const,
    };
    const picked = pickHeadlineRate(zeroWindow, unknownSession);
    expect(picked.headline).toBe(zeroWindow);
    expect(picked.supporting).toEqual([]);
  });

  it("buffered playback (zero container window) keeps the nonzero session rate as headline", () => {
    // Player buffers pause network/disk I/O between bursts: the sampling
    // window legitimately measures 0 while the session is genuinely active.
    const snap = withJellyfinContainerRates(makeFakeSnapshot("direct-play", NOW), {
      netTxBps: 0,
      blockReadBps: 0,
    });
    const egress = byId(snap, "egress:jellyfin->network")!;
    expect(egress.rate!.knownBytesPerSecond).toBe(4_750_000);
    expect(egress.rate!.basis).toBe("source-media");
    // The measured zero window is retained as supporting detail, not erased.
    expect(egress.supportingRates).toHaveLength(1);
    expect(egress.supportingRates![0]).toMatchObject({
      basis: "container-egress",
      knownBytesPerSecond: 0,
      evidence: "measured",
    });

    const playback = byId(snap, "playback:pool:DataStore->jellyfin")!;
    expect(playback.rate!.knownBytesPerSecond).toBe(4_750_000);
    expect(playback.rate!.basis).toBe("storage-attribution");
    expect(playback.supportingRates![0]).toMatchObject({
      basis: "container-block-read",
      knownBytesPerSecond: 0,
    });
  });

  it("positive measured container rates still take precedence during live playback", () => {
    const snap = makeFakeSnapshot("direct-play", NOW); // container 39 MB/s egress
    const egress = byId(snap, "egress:jellyfin->network")!;
    expect(egress.rate!.basis).toBe("container-egress");
    expect(egress.rate!.evidence).toBe("measured");
    expect(egress.evidence).toBe("measured");
    expect(egress.supportingRates ?? []).toEqual([]);
  });

  it("pool-path attribution is DERIVED even when the container rate is measured", () => {
    const snap = makeFakeSnapshot("direct-play", NOW); // container blockRead 42 MB/s
    const playback = byId(snap, "playback:pool:DataStore->jellyfin")!;
    // The rate observation stays measured container evidence…
    expect(playback.rate!.basis).toBe("container-block-read");
    expect(playback.rate!.evidence).toBe("measured");
    // …but the DataStore→Jellyfin PATH is a configuration-derived attribution:
    // block counters do not prove which pool supplied the reads.
    expect(playback.evidence).toBe("derived");
    expect(playback.provenance).toContain("attributed to DataStore");
    expect(playback.provenance).toContain("not device-verified");
  });
});

describe("deriveFlows — paused sessions are not activity (V2.1 pause truth)", () => {
  /** Mark the given session ids paused (upstream-reported state). */
  function withPaused(snap: DashboardSnapshot, ids: string[]): DashboardSnapshot {
    return {
      ...snap,
      jellyfin: {
        ...snap.jellyfin,
        sessions: snap.jellyfin.sessions.map((s) =>
          ids.includes(s.id) ? { ...s, paused: true } : s,
        ),
      },
    };
  }

  const playbackFlows = (snap: DashboardSnapshot) =>
    ids(snap).filter((id) => id.startsWith("playback:") || id.startsWith("egress:"));

  it("a playing transcode with a reported output rate emits rated flows", () => {
    const snap = withJellyfinContainerRates(makeFakeSnapshot("transcode", NOW), {
      netTxBps: null,
      blockReadBps: null,
    });
    const egress = byId(snap, "egress:jellyfin->network")!;
    expect(egress.rate!.knownBytesPerSecond).toBe(1_500_000);
    expect(egress.rate!.coverage).toBe("complete");
  });

  it("a playing transcode without any rate stays an honest state-only flow", () => {
    const base = makeFakeSnapshot("transcode", NOW);
    const snap = withJellyfinContainerRates(
      {
        ...base,
        jellyfin: {
          ...base.jellyfin,
          sessions: base.jellyfin.sessions.map((s) => ({ ...s, rate: null })),
        },
      },
      { netTxBps: null, blockReadBps: null },
    );
    const egress = byId(snap, "egress:jellyfin->network")!;
    expect(egress.evidence).toBe("state-only");
    expect(egress.rate!.knownBytesPerSecond).toBeNull();
    expect(egress.rate!.unknownContributors).toBe(1);
  });

  it("a paused transcode emits no playback or egress flow at all", () => {
    const snap = makeFakeSnapshot("paused", NOW);
    expect(snap.jellyfin.sessions).toHaveLength(1);
    expect(snap.jellyfin.sessions[0]!.paused).toBe(true);
    expect(playbackFlows(snap)).toEqual([]);
  });

  it("a paused direct play emits no playback or egress flow", () => {
    const snap = withPaused(makeFakeSnapshot("direct-play", NOW), ["s1"]);
    expect(playbackFlows(snap)).toEqual([]);
  });

  it("pause → resume restores the playback flows", () => {
    const paused = withPaused(makeFakeSnapshot("direct-play", NOW), ["s1"]);
    expect(playbackFlows(paused)).toEqual([]);
    const resumed: DashboardSnapshot = {
      ...paused,
      jellyfin: {
        ...paused.jellyfin,
        sessions: paused.jellyfin.sessions.map((s) => ({ ...s, paused: false })),
      },
    };
    expect(playbackFlows(resumed)).toEqual([
      "playback:pool:DataStore->jellyfin",
      "egress:jellyfin->network",
    ]);
  });

  it("mixed playing + paused aggregates ONLY the playing sessions", () => {
    // mixed-session: s1 known 4.75 MB/s, s2 known ~1.19 MB/s, s3 unknown.
    // Pausing s2 must drop its rate from the sum without inventing an unknown.
    const snap = withJellyfinContainerRates(
      withPaused(makeFakeSnapshot("mixed-session", NOW), ["s2"]),
      { netTxBps: null, blockReadBps: null },
    );
    const egress = byId(snap, "egress:jellyfin->network")!;
    expect(egress.rate!.knownBytesPerSecond).toBe(4_750_000);
    expect(egress.rate!.unknownContributors).toBe(1); // s3 (playing, unknown) only
    expect(egress.rate!.coverage).toBe("partial");
    expect(egress.label).toBe("Jellyfin playback · 2 sessions");
  });

  it("a paused unknown-rate session is not an unknown contributor", () => {
    const snap = withJellyfinContainerRates(
      withPaused(makeFakeSnapshot("mixed-session", NOW), ["s3"]),
      { netTxBps: null, blockReadBps: null },
    );
    const egress = byId(snap, "egress:jellyfin->network")!;
    expect(egress.rate!.unknownContributors).toBe(0);
    expect(egress.rate!.coverage).toBe("complete");
    expect(egress.rate!.knownBytesPerSecond).toBe(4_750_000 + 1_187_500);
  });

  it("all sessions paused emit no session-derived rate — even with positive container telemetry", () => {
    // Positive mapped-container egress while everything is paused stays
    // measured CONTAINER activity; it is not attributed to playback without
    // a corroborating playing session.
    const snap = withJellyfinContainerRates(
      withPaused(makeFakeSnapshot("multi-session", NOW), ["s1", "s2"]),
      { netTxBps: 9_000_000, blockReadBps: 9_000_000 },
    );
    expect(playbackFlows(snap)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";
import { FAKE_CPU_TOPOLOGY } from "@/lib/fake/telemetry";
import {
  classifyFlowRate,
  deriveFlows,
  resolveJellyfinPlayback,
} from "@/lib/topology/activity";
import type { DashboardSnapshot } from "@/lib/types";
import {
  buildKineticScene,
  cpuTopologyLabel,
  physicalCoreCells,
  rateIntensity,
  type KineticScene,
} from "./model";
import { buildKineticLayout, stageGeometryKey } from "./layout";
import { sceneAnimates } from "./render";

const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);

function scene(scenario: Parameters<typeof makeFakeSnapshot>[0]) {
  return buildKineticScene(makeFakeSnapshot(scenario, NOW), {
    now: NOW,
    seerrConfigured: true,
  });
}

function sceneOf(snapshot: DashboardSnapshot): KineticScene {
  return buildKineticScene(snapshot, { now: NOW, seerrConfigured: true });
}

/** Deep-cloned fake snapshot safe to mutate for targeted evidence cases. */
function mutableSnapshot(
  scenario: Parameters<typeof makeFakeSnapshot>[0],
): DashboardSnapshot {
  return structuredClone(makeFakeSnapshot(scenario, NOW));
}

function setJellyfinContainerEgress(
  snapshot: DashboardSnapshot,
  netTxBps: number | null,
): void {
  const container = snapshot.telemetry.docker.value?.containers.find(
    (c) => c.name === snapshot.jellyfinContainer,
  );
  if (!container) throw new Error("fixture has no mapped Jellyfin container");
  container.netTxBps = netTxBps;
}

function egressFlow(s: KineticScene) {
  const flow = s.flows.find((f) => f.kind === "egress");
  if (!flow) throw new Error("no egress flow in scene");
  return flow;
}

function jellyfin(s: KineticScene) {
  return s.anchors.find((a) => a.id === "jellyfin")!;
}


describe("buildKineticScene", () => {
  it("keeps a quiet host quiet: no flows, no anchor glow, nothing animates", () => {
    const s = scene("idle");
    expect(s.flows).toEqual([]);
    for (const anchor of s.anchors) {
      expect(anchor.active).toBe(false);
      expect(anchor.glow).toBe(0);
      expect(anchor.rateLine).toBeNull();
    }
    expect(sceneAnimates(s)).toBe(false);
    expect(s.attention.headline).toBeNull();
  });

  it("renders a real download as particle flows and wakes the WAN edge", () => {
    const s = scene("downloads");
    const wan = s.flows.find((f) => f.kind === "wan-transfer");
    expect(wan?.treatment).toBe("particles");
    expect(wan?.rateBps).toBeGreaterThan(0);
    expect(s.edges.find((e) => e.id === "wan")?.active).toBe(true);
    const qb = s.anchors.find((a) => a.id === "qbittorrent")!;
    expect(qb.active).toBe(true);
    expect(qb.rateLine).toMatch(/^↓ /);
    expect(sceneAnimates(s)).toBe(true);
  });

  it("never draws control-plane orchestration as a flow in overview", () => {
    for (const id of ["downloads", "active", "importing"] as const) {
      expect(scene(id).flows.some((f) => f.kind === "control")).toBe(false);
    }
  });

  it("models cross-pool import as a pool-to-pool copy plus an organize whisper", () => {
    const s = scene("cross-pool-import");
    const copy = s.flows.find((f) => f.kind === "import-copy");
    expect(copy).toBeDefined();
    expect(copy!.from).toEqual({ kind: "pool", name: "NVME" });
    expect(copy!.to).toEqual({ kind: "pool", name: "DataStore" });
    expect(copy!.tone).toBe("import");
    expect(copy!.treatment).toBe("particles");
    const organize = s.flows.find((f) => f.kind === "organize");
    expect(organize?.treatment).toBe("state-only");
    expect(organize?.rateBps).toBeNull();
  });

  it("keeps same-pool import local: organize only, no import-copy tunnel", () => {
    const s = scene("same-pool-import");
    expect(s.flows.some((f) => f.kind === "import-copy")).toBe(false);
    expect(s.flows.some((f) => f.kind === "organize")).toBe(true);
  });

  it("freezes stale work instead of animating it", () => {
    const snapshot = makeFakeSnapshot("stale", NOW);
    const s = buildKineticScene(snapshot, { now: NOW, seerrConfigured: true });
    expect(s.flows.length).toBeGreaterThan(0);
    // The fixture holds last-known-good data on a stale connector: every flow
    // owned by that connector must freeze, and no stale flow may ever carry
    // particle motion.
    expect(s.flows.some((f) => f.treatment === "stale")).toBe(true);
    const stale = s.flows.filter((f) => f.treatment === "stale");
    for (const flow of stale) {
      expect(flow.treatment).not.toBe("particles");
    }
  });

  it("keeps a confirmed-zero transfer visible but motionless", () => {
    const s = scene("confirmed-zero");
    const wan = s.flows.find((f) => f.kind === "wan-transfer");
    expect(wan?.treatment).toBe("confirmed-zero");
    expect(wan?.rateBps).toBe(0);
    // The authoritative complete zero renders NO motion of any kind.
    expect(sceneAnimates(s)).toBe(false);
    // The underlying observation proves the zero: complete coverage, no
    // unknown contributors, live measured evidence.
    const obs = deriveFlows(makeFakeSnapshot("confirmed-zero", NOW), NOW).find(
      (f) => f.kind === "wan-transfer",
    )!;
    expect(obs.rate).toMatchObject({
      knownBytesPerSecond: 0,
      unknownContributors: 0,
      coverage: "complete",
      evidence: "measured",
      freshness: "live",
    });
    expect(classifyFlowRate(obs)).toBe("confirmed-zero");
  });

  it("summarizes attention truthfully", () => {
    const s = scene("attention");
    expect(s.attention.critical).toBeGreaterThan(0);
    expect(s.attention.headline).toMatch(/critical/);
    expect(s.critical).toBe(true);
  });

  it("carries the full 44-container population as field cells with capped labels", () => {
    const s = scene("container-field-real");
    const cells = s.field.flatMap((g) => g.cells);
    // Everything except the first-class services (which are anchors and
    // orchestrators, not field cells) must be represented.
    expect(s.fieldTotal).toBe(44);
    expect(cells.length).toBeGreaterThanOrEqual(38);
    for (const group of s.field) {
      const plainLabels = group.cells.filter((c) => c.labelVisible && !c.attention);
      expect(plainLabels.length).toBeLessThanOrEqual(2);
    }
    // Attention names itself.
    for (const cell of cells.filter((c) => c.attention)) {
      expect(cell.labelVisible).toBe(true);
    }
  });

  it("orders storage download → media → other and preserves capacity truth", () => {
    const s = scene("idle");
    expect(s.storage.map((p) => p.role)).toEqual(["download", "media", "other"]);
    const media = s.storage.find((p) => p.role === "media")!;
    expect(media.name).toBe("DataStore");
    expect(media.capacityFraction).toBeGreaterThan(0);
    expect(media.capacityFraction).toBeLessThanOrEqual(1);
  });
});

/**
 * V4 rate-truth blocker: the Jellyfin anchor, egress ribbon, glow energy and
 * inspector must all derive from ONE canonical resolved playback rate
 * (`resolveJellyfinPlayback`). These cases pin the full V2/V3 precedence:
 * measured egress wins, reported session output is used when measurement is
 * absent, estimates stay estimates, measured zero never erases contradictory
 * session evidence, partial stays partial, unknown stays unknown.
 */
describe("canonical Jellyfin rate agreement (anchor == ribbon)", () => {
  it("transcode: reported session output carries the headline when no container egress is measured", () => {
    const snapshot = mutableSnapshot("transcode");
    setJellyfinContainerEgress(snapshot, null);
    const s = sceneOf(snapshot);
    const flow = egressFlow(s);
    expect(flow.rateBps).toBe(1_500_000);
    const anchor = jellyfin(s);
    expect(anchor.rateLine).toBe("↑ 1.5 MB/s");
    expect(anchor.glow).toBeGreaterThan(0.35);
    const resolved = resolveJellyfinPlayback(snapshot, NOW)!;
    expect(resolved.egress.headline.basis).toBe("jellyfin-session-output");
    expect(resolved.egress.headline.knownBytesPerSecond).toBe(flow.rateBps);
  });

  it("measured fallback: a missing session bitrate uses the mapped container's measured egress everywhere", () => {
    const snapshot = mutableSnapshot("transcode-fallback");
    // The genuinely captured case: Jellyfin omits every session bitrate field.
    snapshot.jellyfin.sessions[0]!.rate = null;
    setJellyfinContainerEgress(snapshot, 12_000_000);
    const s = sceneOf(snapshot);
    const flow = egressFlow(s);
    expect(flow.rateBps).toBe(12_000_000);
    expect(flow.treatment).toBe("particles");
    const anchor = jellyfin(s);
    // The V2.1 regression this guards: the ribbon knew the measured rate while
    // the anchor showed nothing and its glow read as zero.
    expect(anchor.rateLine).toBe("↑ 12.0 MB/s");
    expect(anchor.glow).toBeGreaterThan(0.35);
    const resolved = resolveJellyfinPlayback(snapshot, NOW)!;
    expect(resolved.egress.headline.basis).toBe("container-egress");
    expect(resolved.egress.headline.evidence).toBe("measured");
  });

  it("direct play: a source-media estimate stays explicitly estimated (≈)", () => {
    const snapshot = mutableSnapshot("direct-stream");
    setJellyfinContainerEgress(snapshot, null);
    const s = sceneOf(snapshot);
    const flow = egressFlow(s);
    expect(flow.rateBps).toBe(4_750_000);
    const anchor = jellyfin(s);
    expect(anchor.rateLine).toBe("≈ ↑ 4.8 MB/s");
    const resolved = resolveJellyfinPlayback(snapshot, NOW)!;
    expect(resolved.egress.headline.evidence).toBe("estimated");
    expect(resolved.egress.headline.basis).toBe("source-media");
  });

  it("mixed sessions: partial coverage reads as a ≈ lower bound, never padded", () => {
    const snapshot = mutableSnapshot("mixed-session");
    setJellyfinContainerEgress(snapshot, null);
    const s = sceneOf(snapshot);
    const flow = egressFlow(s);
    const resolved = resolveJellyfinPlayback(snapshot, NOW)!;
    expect(resolved.egress.headline.coverage).toBe("partial");
    expect(resolved.egress.headline.unknownContributors).toBe(1);
    expect(flow.rateBps).toBe(resolved.egress.headline.knownBytesPerSecond);
    // A POSITIVE partial lower bound stays a live transfer (approximate),
    // it never degrades to state-only merely because coverage is partial.
    expect(flow.treatment).toBe("particles");
    const anchor = jellyfin(s);
    expect(anchor.rateLine).toMatch(/^≈ ↑ /);
  });

  it("playing with rate genuinely unknown: no line, no zero, baseline glow, state-only ribbon", () => {
    const s = scene("transcode-unknown-rate");
    const flow = egressFlow(s);
    expect(flow.treatment).toBe("state-only");
    expect(flow.rateBps).toBeNull();
    const anchor = jellyfin(s);
    expect(anchor.headline).toContain("1 stream");
    expect(anchor.rateLine).toBeNull();
    expect(anchor.active).toBe(true);
    // Unknown ≠ zero: the glow keeps the active baseline instead of dimming
    // as if a zero rate had been measured.
    expect(anchor.glow).toBeCloseTo(0.35, 5);
  });

  it("measured container zero never erases a positive session rate; the zero is retained as supporting evidence", () => {
    const snapshot = mutableSnapshot("transcode");
    setJellyfinContainerEgress(snapshot, 0);
    const s = sceneOf(snapshot);
    const flow = egressFlow(s);
    expect(flow.rateBps).toBe(1_500_000);
    const anchor = jellyfin(s);
    expect(anchor.rateLine).toBe("↑ 1.5 MB/s");
    const resolved = resolveJellyfinPlayback(snapshot, NOW)!;
    expect(resolved.egress.headline.basis).toBe("jellyfin-session-output");
    expect(resolved.egress.supporting).toHaveLength(1);
    expect(resolved.egress.supporting[0]!.knownBytesPerSecond).toBe(0);
    expect(resolved.egress.supporting[0]!.basis).toBe("container-egress");
  });

  it("stale playback evidence freezes: stale ribbon treatment, no anchor glow, last-known line retained", () => {
    const snapshot = mutableSnapshot("transcode");
    const health = snapshot.health.find((h) => h.id === "jellyfin")!;
    health.lastSuccessAt = NOW - 10 * 60_000;
    const s = sceneOf(snapshot);
    const flows = s.flows.filter((f) => f.kind === "egress" || f.kind === "playback");
    expect(flows.length).toBeGreaterThan(0);
    for (const flow of flows) expect(flow.treatment).toBe("stale");
    const anchor = jellyfin(s);
    // Frozen, not erased: the last-known line stays readable while nothing
    // animates and the glow releases (stale is not live activity).
    expect(anchor.rateLine).not.toBeNull();
    expect(anchor.active).toBe(false);
    expect(anchor.glow).toBe(0);
    const resolved = resolveJellyfinPlayback(snapshot, NOW)!;
    expect(resolved.egressFreshness).toBe("stale");
  });
});

/**
 * V4 final review blocker: a PARTIAL known-zero rate is a lower bound
 * ("at least 0 B/s, total unknown"), never a confirmed zero. Only a live,
 * complete, evidence-backed zero may render as `confirmed-zero`; every other
 * numeric zero is state-only activity with no throughput or zero claim.
 */
describe("partial known zero is never a confirmed zero", () => {
  it("Jellyfin: known 0 + unknown session renders state-only, active, with no 0 B/s claim", () => {
    const snapshot = makeFakeSnapshot("partial-zero", NOW);
    const resolved = resolveJellyfinPlayback(snapshot, NOW)!;
    // The fixture is the exact blocker aggregate: known lower bound of zero
    // with an unknown contributor and no measured container fallback.
    expect(resolved.egress.headline.knownBytesPerSecond).toBe(0);
    expect(resolved.egress.headline.coverage).toBe("partial");
    expect(resolved.egress.headline.unknownContributors).toBeGreaterThan(0);

    const s = sceneOf(snapshot);
    for (const kind of ["egress", "playback"] as const) {
      const flow = s.flows.find((f) => f.kind === kind)!;
      expect(flow.treatment).toBe("state-only");
      expect(flow.treatment).not.toBe("confirmed-zero");
      // No particles (the engine emits particles only for `particles`), no
      // throughput-scaled width, and no headline rate for text surfaces to
      // present as an authoritative zero.
      expect(flow.rateBps).toBeNull();
    }

    // Jellyfin stays visibly ACTIVE — playback is known to exist — while the
    // rate line stays silent instead of claiming "0 B/s" or "≈ 0 B/s".
    const anchor = jellyfin(s);
    expect(anchor.active).toBe(true);
    expect(anchor.headline).toContain("2 streams");
    expect(anchor.rateLine).toBeNull();
    expect(anchor.glow).toBeCloseTo(0.35, 5);
    // State-only breathing still animates; nothing implies byte movement.
    expect(sceneAnimates(s)).toBe(true);
  });

  it("qBittorrent: a known-zero direction beside an unknown active direction is partial, not confirmed", () => {
    const snapshot = mutableSnapshot("confirmed-zero");
    // One downloading item whose rate qBittorrent does not report, plus
    // confirmed-idle seeding: the known lower bound is 0 but the total is
    // unknown.
    snapshot.acquisition.rollup.aggregateRateBps = null;
    snapshot.acquisition.rollup.uploadRateBps = 0;
    snapshot.acquisition.rollup.seeding = 2;
    const obs = deriveFlows(snapshot, NOW).find((f) => f.kind === "wan-transfer")!;
    expect(obs.rate).toMatchObject({
      knownBytesPerSecond: 0,
      unknownContributors: 1,
      coverage: "partial",
    });
    expect(classifyFlowRate(obs)).toBe("unknown");
    const s = sceneOf(snapshot);
    const wan = s.flows.find((f) => f.kind === "wan-transfer")!;
    expect(wan.treatment).toBe("state-only");
    expect(wan.rateBps).toBeNull();
  });

  it("a stale zero stays stale, never confirmed-zero", () => {
    const snapshot = mutableSnapshot("confirmed-zero");
    const health = snapshot.health.find((h) => h.id === "qbittorrent")!;
    health.lastSuccessAt = NOW - 10 * 60_000;
    const s = sceneOf(snapshot);
    const flows = s.flows.filter(
      (f) => f.kind === "wan-transfer" || f.kind === "storage-transfer",
    );
    expect(flows.length).toBeGreaterThan(0);
    for (const flow of flows) {
      expect(flow.treatment).toBe("stale");
    }
  });
});

describe("active download with unknown rate (final producer audit)", () => {
  it("keeps the WAN and storage conduits alive as state-only instead of disappearing", () => {
    // qBittorrent truthfully reports active downloads while its transfer
    // counters are unavailable: known work + unknown magnitude must be a
    // state-only path, never absence.
    const snapshot = mutableSnapshot("downloads");
    snapshot.acquisition.rollup.aggregateRateBps = null;
    snapshot.acquisition.rollup.uploadRateBps = 0;
    snapshot.acquisition.rollup.seeding = 0;
    expect(snapshot.acquisition.rollup.downloading).toBeGreaterThan(0);

    const observations = deriveFlows(snapshot, NOW);
    const wan = observations.find((f) => f.kind === "wan-transfer");
    const storage = observations.find((f) => f.kind === "storage-transfer");
    expect(wan).toBeDefined();
    expect(storage).toBeDefined();
    for (const obs of [wan!, storage!]) {
      expect(obs.evidence).toBe("state-only");
      expect(obs.rate).toMatchObject({
        knownBytesPerSecond: null,
        unknownContributors: 1,
        coverage: "unknown",
      });
      expect(obs.channels).toHaveLength(1);
      expect(obs.channels[0]!.bytesPerSecond).toBeNull();
      expect(classifyFlowRate(obs)).toBe("unknown");
    }

    const s = sceneOf(snapshot);
    const kineticWan = s.flows.find((f) => f.kind === "wan-transfer")!;
    const kineticStorage = s.flows.find((f) => f.kind === "storage-transfer")!;
    for (const flow of [kineticWan, kineticStorage]) {
      // State-only: breathing hairline, no particles, no throughput width,
      // and no numeric claim anywhere downstream.
      expect(flow.treatment).toBe("state-only");
      expect(flow.rateBps).toBeNull();
    }
    // qBittorrent still reads as downloading — without a fabricated rate.
    const qb = s.anchors.find((a) => a.id === "qbittorrent")!;
    expect(qb.active).toBe(true);
    expect(qb.headline).toContain("downloading");
    expect(qb.rateLine).toBeNull();
    expect(qb.glow).toBeCloseTo(0.35, 5);
  });

  it("keeps an unknown active direction as a nullable channel beside a known one", () => {
    const snapshot = mutableSnapshot("seeding");
    snapshot.acquisition.rollup.aggregateRateBps = null; // download rate lost
    const wan = deriveFlows(snapshot, NOW).find((f) => f.kind === "wan-transfer")!;
    // Both directions participate: the seed carries its measured rate, the
    // download rides as an explicit unknown — partial, never complete.
    expect(wan.channels).toHaveLength(2);
    expect(wan.channels.find((c) => c.direction === "forward")!.bytesPerSecond).toBeNull();
    expect(wan.channels.find((c) => c.direction === "reverse")!.bytesPerSecond).toBeGreaterThan(0);
    expect(wan.rate).toMatchObject({ coverage: "partial", unknownContributors: 1 });
    expect(classifyFlowRate(wan)).toBe("positive");
  });
});

describe("network boundary truth", () => {
  it("labels the client edge neutrally when the egress boundary is unknown", () => {
    for (const scenario of ["idle", "transcode", "direct-play", "active"] as const) {
      const s = scene(scenario);
      const clients = s.edges.find((e) => e.id === "clients")!;
      expect(clients.labels).toEqual(["CLIENTS"]);
    }
  });

  it("keeps the WAN edge a WAN claim only for the protocol-justified transfer", () => {
    const s = scene("downloads");
    const wan = s.flows.find((f) => f.kind === "wan-transfer")!;
    expect(wan.boundary).toBe("wan");
    const egressBoundaries = s.flows
      .filter((f) => f.to.kind === "edge" && f.to.id === "clients")
      .map((f) => f.boundary);
    for (const b of egressBoundaries) expect(b).toBe("unknown");
  });
});

describe("physicalCoreCells", () => {
  it("aggregates sibling threads onto physical cores by mean", () => {
    const perCore = Array.from({ length: 88 }, (_, i) => (i < 44 ? 1 : 0));
    const { cells, cellKind } = physicalCoreCells(perCore, FAKE_CPU_TOPOLOGY);
    expect(cellKind).toBe("physical-core");
    expect(cells).toHaveLength(44);
    // Each core has one busy sibling (1.0) and one idle sibling (0.0).
    for (const cell of cells) expect(cell).toBeCloseTo(0.5, 6);
  });

  it("falls back to logical cells without usable topology", () => {
    const perCore = [0.1, 0.2, 0.3, 0.4];
    expect(physicalCoreCells(perCore, null)).toEqual({
      cellKind: "logical-cpu",
      cells: perCore,
    });
    // Sibling ids out of range invalidate the physical mapping.
    const bad = { logicalCpus: 4, sockets: 1, physicalCores: 2, coreSiblings: [[0, 9], [1, 3]] };
    expect(physicalCoreCells(perCore, bad).cellKind).toBe("logical-cpu");
  });
});

describe("cpuTopologyLabel", () => {
  it("labels full topology as C/T and partial as T-only", () => {
    expect(cpuTopologyLabel(FAKE_CPU_TOPOLOGY, 88)).toBe("44C / 88T");
    expect(
      cpuTopologyLabel(
        { logicalCpus: 32, sockets: null, physicalCores: null, coreSiblings: null },
        32,
      ),
    ).toBe("32T");
    expect(cpuTopologyLabel(null, 32)).toBe("32T");
    expect(cpuTopologyLabel(null, 0)).toBeNull();
  });
});

describe("scene wiring of detected topology", () => {
  it("shows one cell per physical core with the 44C / 88T label", () => {
    const s = scene("idle");
    expect(s.instrument.cpu.cellKind).toBe("physical-core");
    expect(s.instrument.cpu.cells).toHaveLength(44);
    expect(s.instrument.cpu.topologyLabel).toBe("44C / 88T");
  });
});

describe("rateIntensity", () => {
  it("is 0 below the deadband and saturates at 200 MB/s", () => {
    expect(rateIntensity(0)).toBe(0);
    expect(rateIntensity(15_999)).toBe(0);
    expect(rateIntensity(16_000)).toBe(0);
    expect(rateIntensity(200_000_000)).toBe(1);
    expect(rateIntensity(400_000_000)).toBe(1);
    const mid = rateIntensity(1_000_000);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
});

describe("buildKineticLayout", () => {
  it("is deterministic and keeps every element inside the stage", () => {
    const s = scene("container-field-real");
    const a = buildKineticLayout(s, 1920, 1080);
    const b = buildKineticLayout(s, 1920, 1080);
    expect(a).toEqual(b);
    for (const group of a.groups) {
      for (const cell of group.cells) {
        expect(cell.x).toBeGreaterThan(0);
        expect(cell.x).toBeLessThan(1920);
        expect(cell.y).toBeGreaterThan(a.bandH);
        expect(cell.y).toBeLessThan(a.storageTop);
      }
    }
    for (const stratum of a.strata) {
      expect(stratum.x).toBeGreaterThanOrEqual(0);
      expect(stratum.x + stratum.w).toBeLessThanOrEqual(1920);
    }
  });

  it("separates the 44-container field with no visible cell overlap, including at 1280×720", () => {
    const s = scene("container-field-real");
    for (const [w, h] of [
      [1920, 1080],
      [1280, 720],
    ] as const) {
      const layout = buildKineticLayout(s, w, h);
      const all = layout.groups.flatMap((g) =>
        g.cells.map((c) => ({ ...c, group: g.id, labelY: g.labelY })),
      );
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const a = all[i]!;
          const b = all[j]!;
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          expect(d, `${a.id} vs ${b.id} at ${w}x${h}`).toBeGreaterThanOrEqual(
            a.r + b.r + 1,
          );
        }
      }
      // Cells never sit on their group caption row.
      for (const cell of all) {
        expect(cell.y + cell.r).toBeLessThanOrEqual(cell.labelY - 2);
      }
    }
  });

  it("stays bounded and finite under the over-budget stress fixture", () => {
    const s = scene("container-field-stress");
    const layout = buildKineticLayout(s, 1920, 1080);
    const again = buildKineticLayout(s, 1920, 1080);
    expect(layout).toEqual(again);
    for (const group of layout.groups) {
      for (const cell of group.cells) {
        expect(Number.isFinite(cell.x)).toBe(true);
        expect(Number.isFinite(cell.y)).toBe(true);
        expect(cell.y).toBeGreaterThan(layout.bandH * 0.9);
        expect(cell.y).toBeLessThan(layout.storageTop);
      }
    }
  });

  it("keeps stage geometry byte-stable across telemetry-only updates", () => {
    const NOW2 = NOW + 2_000;
    const a = makeFakeSnapshot("downloads", NOW);
    const b = makeFakeSnapshot("downloads", NOW2); // rates wobble with the clock
    const sceneA = buildKineticScene(a, { now: NOW, seerrConfigured: true });
    const sceneB = buildKineticScene(b, { now: NOW2, seerrConfigured: true });
    // The geometry key must not see rate/CPU/memory movement…
    expect(stageGeometryKey(sceneA, 1920, 1080)).toBe(stageGeometryKey(sceneB, 1920, 1080));
    // …and membership or viewport changes must change it.
    const idle = buildKineticScene(makeFakeSnapshot("docker-unavailable", NOW), {
      now: NOW,
      seerrConfigured: true,
    });
    expect(stageGeometryKey(idle, 1920, 1080)).not.toBe(stageGeometryKey(sceneA, 1920, 1080));
    expect(stageGeometryKey(sceneA, 1280, 720)).not.toBe(stageGeometryKey(sceneA, 1920, 1080));
  });

  it("lays a path for every flow", () => {
    const s = scene("active");
    const layout = buildKineticLayout(s, 1280, 720);
    expect(layout.flows.map((f) => f.id).sort()).toEqual(
      s.flows.map((f) => f.id).sort(),
    );
    for (const flow of layout.flows) {
      expect(flow.path.total).toBeGreaterThan(40);
    }
  });
});

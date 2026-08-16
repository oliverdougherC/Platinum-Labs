import { describe, expect, it } from "vitest";
import {
  buildSceneModel,
  capacityTone,
  containerMetricCoverage,
  containerRadius,
  containerResourceScore,
} from "@/lib/scene/model";
import {
  computeLayout,
  MAX_RENDERED_CONTAINERS,
  WORLD_H,
  type SceneLayout,
} from "@/lib/scene/layout";
import { buildLabels, describeFlow, labelsOverlap } from "@/lib/scene/labels";
import {
  flowOverlayIsLive,
  containerMotionOffset,
  containerStrokeTreatment,
  tunnelBodyIsBidirectional,
  tunnelEndpointTokens,
} from "@/lib/scene/render";
import {
  dormantRoutes,
  pathClearance,
  PORT_PAD,
  routeFlows,
  sweepThrough,
} from "@/lib/scene/routing";
import { networkIntensity, SceneMotion } from "@/lib/scene/motion";
import { dist } from "@/lib/scene/geom";
import { buildBackground } from "@/lib/scene/background";
import { appConfig } from "@/lib/config";
import { deriveFlows } from "@/lib/topology/activity";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";
import {
  FAKE_CORE_COUNT,
  REAL_FIELD_CONTAINER_COUNT,
  STRESS_FIELD_CONTAINER_COUNT,
} from "@/lib/fake/telemetry";
import { testPool } from "@/lib/test/factories";
import type { BodyGeom } from "@/lib/scene/layout";
import type { SceneModel } from "@/lib/scene/model";
import { placeTooltip } from "@/components/topology/scene";

const NOW = 1_754_000_000_000;

/** The two target monitors (spec §13). Aspect is what layout consumes. */
const VIEWPORTS = [
  { w: 1920, h: 1080 - 48 - 40 }, // minus app chrome (header + rail)
  { w: 2560, h: 1440 - 48 - 40 },
];

function model(scenario: Parameters<typeof makeFakeSnapshot>[0]): SceneModel {
  return buildSceneModel(makeFakeSnapshot(scenario, NOW), {
    seerrConfigured: true,
    now: NOW,
  });
}

function allBodies(layout: SceneLayout): BodyGeom[] {
  const bodies = [...layout.services.values(), ...layout.storage.values()];
  if (layout.genericStorage) bodies.push(layout.genericStorage);
  return bodies;
}

describe("scene model semantics", () => {
  it("keeps the REAL per-core count — never padded or truncated", () => {
    expect(model("idle").core.perCore).toHaveLength(FAKE_CORE_COUNT);
  });

  it("Requests without runtime health is neutral, not healthy (PLA-266 blocker)", () => {
    const m = buildSceneModel(makeFakeSnapshot("idle", NOW), {
      seerrConfigured: true,
      now: NOW,
    });
    expect(m.services.find((s) => s.id === "seerr")!.status).toBe("neutral");
    const off = buildSceneModel(makeFakeSnapshot("idle", NOW), {
      seerrConfigured: false,
      now: NOW,
    });
    expect(off.services.find((s) => s.id === "seerr")!.status).toBe("not-configured");
  });

  it("capacity tones come from the SAME thresholds as the attention engine", () => {
    const { storageWarnFraction, storageCriticalFraction } = appConfig.thresholds;
    expect(capacityTone(storageWarnFraction - 0.001)).toBe("ok");
    expect(capacityTone(storageWarnFraction)).toBe("warn");
    expect(capacityTone(storageCriticalFraction)).toBe("critical");
  });

  it("qBittorrent is active for downloading and/or seeding, with concise activity detail", () => {
    const downloading = model("downloads").services.find((s) => s.id === "qbittorrent")!;
    expect(downloading.active).toBe(true);
    expect(downloading.detail).toBe("downloading");

    const seedingSnapshot = makeFakeSnapshot("idle", NOW);
    const seeding = buildSceneModel(
      {
        ...seedingSnapshot,
        acquisition: {
          ...seedingSnapshot.acquisition,
          rollup: {
            ...seedingSnapshot.acquisition.rollup,
            uploadRateBps: 5_800_000,
            seeding: 4,
          },
        },
      },
      { seerrConfigured: true, now: NOW },
    ).services.find((s) => s.id === "qbittorrent")!;
    expect(seeding.active).toBe(true);
    expect(seeding.detail).toBe("seeding");
    expect(seeding.count).toBe(4);

    const both = model("seeding").services.find((s) => s.id === "qbittorrent")!;
    expect(both.active).toBe(true);
    expect(both.detail).toBe("downloading 1 · seeding 4");
    expect(both.count).toBeNull();
  });

  it("a paused session reads paused — never streaming/transcoding — and does not glow", () => {
    const paused = model("paused").services.find((s) => s.id === "jellyfin")!;
    expect(paused.detail).toBe("paused");
    expect(paused.active).toBe(false);
    expect(paused.count).toBe(1); // the session stays visible, it just is not work

    // Mixed playing + paused: the playing sessions carry the detail word and
    // the paused remainder is named, not silently absorbed.
    const mixedSnapshot = makeFakeSnapshot("multi-session", NOW);
    const mixed = buildSceneModel(
      {
        ...mixedSnapshot,
        jellyfin: {
          ...mixedSnapshot.jellyfin,
          sessions: mixedSnapshot.jellyfin.sessions.map((s, i) =>
            i === 0 ? { ...s, paused: true } : s,
          ),
        },
      },
      { seerrConfigured: true, now: NOW },
    ).services.find((s) => s.id === "jellyfin")!;
    expect(mixed.active).toBe(true);
    expect(mixed.detail).toBe("transcoding · 1 paused");
    expect(mixed.count).toBe(2);
  });

  it("paused sessions create no service glow, flow width, or breathing paths", () => {
    const m = model("paused");
    expect(m.flows).toEqual([]);
    const motion = new SceneMotion();
    motion.applyModel(m);
    motion.advance(0);
    motion.advance(10_000);
    expect(motion.liveFlows()).toEqual([]);
    expect(motion.serviceGlowOf("jellyfin")).toBe(0);
  });

  it("labels retained network rates explicitly as stale", () => {
    const staleModel = {
      ...model("downloads"),
      network: { ...model("downloads").network, status: "stale" as const },
    };
    const layout = computeLayout(staleModel, 16 / 9);
    const network = buildLabels(staleModel, layout, NOW).find((label) => label.id === "network")!;
    expect(network.secondary).toContain("stale");
    expect(network.secondaryTone).toBe("warn");
  });

  it("bounds nonlinear container resource size and keeps unknown metrics quiet", () => {
    expect(containerResourceScore(null, null)).toBe(0);
    expect(containerRadius(containerResourceScore(null, null))).toBe(3);
    expect(containerRadius(-10)).toBe(3);
    expect(containerRadius(10)).toBe(13);
    expect(containerResourceScore(8, 64 * 1024 ** 3)).toBeLessThanOrEqual(1);
  });

  it("retains container metrics and gates motion for stale and reduced-motion state", () => {
    const live = model("active").docker.containers.find((container) => container.name === "jellyfin")!;
    expect(live.netTxBps).not.toBeNull();
    expect(live.blockReadBps).not.toBeNull();
    expect(live.serviceAssociation).toBe("jellyfin");
    expect(containerMotionOffset(live, 0, true).x).not.toBe(0);
    expect(containerMotionOffset(live, 0, false)).toEqual({ x: 0, y: 0 });

    const snapshot = makeFakeSnapshot("active", NOW);
    snapshot.telemetry.docker.status = "stale";
    const stale = buildSceneModel(snapshot, { seerrConfigured: true, now: NOW })
      .docker.containers.find((container) => container.name === "jellyfin")!;
    expect(stale.freshness).toBe("stale");
    expect(containerMotionOffset(stale, 0, true)).toEqual({ x: 0, y: 0 });
  });

  it("uses an explicit safe host label and a generic fallback", () => {
    const snapshot = makeFakeSnapshot("idle", NOW);
    snapshot.hostLabel = "Lab compute";
    expect(buildSceneModel(snapshot, { seerrConfigured: true, now: NOW }).core.hostname)
      .toBe("Lab compute");
    delete snapshot.hostLabel;
    expect(buildSceneModel(snapshot, { seerrConfigured: true, now: NOW }).core.hostname)
      .toBe("host");
  });

  it("scales network energy against 1 GbE, 10 GbE, and a conservative unknown link", () => {
    const oneGbE = 125_000_000;
    const tenGbE = 1_250_000_000;
    expect(networkIntensity(oneGbE, oneGbE)).toBe(1);
    expect(networkIntensity(oneGbE, tenGbE)).toBeCloseTo(Math.sqrt(0.1), 6);
    expect(networkIntensity(oneGbE, null)).toBeCloseTo(Math.sqrt(0.1), 6);
    expect(networkIntensity(40_000, tenGbE)).toBeLessThan(0.01);
    expect(networkIntensity(tenGbE * 4, tenGbE)).toBe(1);
    expect(networkIntensity(null, oneGbE)).toBe(0);
  });
});

describe("container metric coverage — unknown is never confirmed idle (PLA-273)", () => {
  const metrics = (
    overrides: Partial<Parameters<typeof containerMetricCoverage>[0]>,
  ): Parameters<typeof containerMetricCoverage>[0] => ({
    cpuFraction: 0.2,
    memoryBytes: 512 * 1024 ** 2,
    netRxBps: 1_000,
    netTxBps: 1_000,
    blockReadBps: 500,
    blockWriteBps: 500,
    ...overrides,
  });

  /** A live container model built straight from the fake snapshot, mutated. */
  function liveContainer(
    mutate: (c: import("@/lib/types").DockerContainerTelemetry) => void,
  ) {
    const snapshot = makeFakeSnapshot("active", NOW);
    const target = snapshot.telemetry.docker.value!.containers.find(
      (c) => c.name === "sonarr",
    )!;
    mutate(target);
    return buildSceneModel(snapshot, { seerrConfigured: true, now: NOW })
      .docker.containers.find((c) => c.name === "sonarr")!;
  }

  it("a confirmed all-zero sample is complete coverage and a solid quiet body", () => {
    const container = liveContainer((c) => {
      c.cpuFraction = 0;
      c.memoryBytes = 0;
      c.netRxBps = 0;
      c.netTxBps = 0;
      c.blockReadBps = 0;
      c.blockWriteBps = 0;
    });
    expect(container.metricCoverage).toBe("complete");
    expect(containerStrokeTreatment(container)).toEqual({ token: "fg", dash: null });
  });

  it("all metrics null (collector refresh-budget skip) is unavailable — dashed, static", () => {
    const container = liveContainer((c) => {
      c.cpuFraction = null;
      c.memoryBytes = null;
      c.netRxBps = null;
      c.netTxBps = null;
      c.blockReadBps = null;
      c.blockWriteBps = null;
    });
    expect(container.metricCoverage).toBe("unavailable");
    expect(container.state).toBe("running"); // state known, metrics not
    // Neutral dashed treatment, distinct from unknown-STATE (faint [2,2]).
    expect(containerStrokeTreatment(container)).toEqual({ token: "muted", dash: [4, 3] });
    // No metrics ⇒ no motion, even while the docker domain is live.
    expect(containerMotionOffset(container, 3, true)).toEqual({ x: 0, y: 0 });
    expect(container.ioIntensity).toBe(0);
  });

  it("CPU known / memory unknown is partial coverage", () => {
    expect(containerMetricCoverage(metrics({ memoryBytes: null }))).toBe("partial");
  });

  it("I/O unknown with known cpu+memory is partial coverage (cgroup v2 blkio case)", () => {
    expect(
      containerMetricCoverage(
        metrics({ netRxBps: null, netTxBps: null, blockReadBps: null, blockWriteBps: null }),
      ),
    ).toBe("partial");
    expect(containerMetricCoverage(metrics({}))).toBe("complete");
  });

  it("stale last-known-good metrics keep their shape but never animate", () => {
    const snapshot = makeFakeSnapshot("active", NOW);
    snapshot.telemetry.docker.status = "stale";
    const container = buildSceneModel(snapshot, { seerrConfigured: true, now: NOW })
      .docker.containers.find((c) => c.name === "jellyfin")!;
    expect(container.freshness).toBe("stale");
    expect(container.metricCoverage).toBe("complete"); // values retained…
    expect(container.radius).toBeGreaterThan(3); // …so the body keeps its size
    expect(containerMotionOffset(container, 3, true)).toEqual({ x: 0, y: 0 });
  });

  it("unknown-state containers keep their distinct unverified treatment", () => {
    const container = liveContainer((c) => {
      c.state = "unknown";
      c.cpuFraction = null;
      c.memoryBytes = null;
    });
    expect(container.unverified).toBe(true);
    expect(containerStrokeTreatment(container)).toEqual({ token: "faint", dash: [2, 2] });
  });
});

describe("layout determinism and bounds", () => {
  it("same model + same aspect ⇒ identical layout", () => {
    const m = model("active");
    const a = computeLayout(m, 1920 / 992);
    const b = computeLayout(m, 1920 / 992);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("keeps container positions stable across telemetry ordering changes", () => {
    const snapshot = makeFakeSnapshot("active", NOW);
    const forward = buildSceneModel(snapshot, { seerrConfigured: true, now: NOW });
    const reversed = buildSceneModel({
      ...snapshot,
      telemetry: {
        ...snapshot.telemetry,
        docker: {
          ...snapshot.telemetry.docker,
          value: snapshot.telemetry.docker.value
            ? {
                ...snapshot.telemetry.docker.value,
                containers: [...snapshot.telemetry.docker.value.containers].reverse(),
              }
            : null,
        },
      },
    }, { seerrConfigured: true, now: NOW });
    const a = computeLayout(forward, 16 / 9);
    const b = computeLayout(reversed, 16 / 9);
    expect([...a.containerField.entries()]).toEqual([...b.containerField.entries()]);
  });

  it("container centers depend on identity, not telemetry (PLA-272 stability)", () => {
    const baseline = makeFakeSnapshot("active", NOW);
    const centersOf = (snapshot: typeof baseline) => {
      const layout = computeLayout(
        buildSceneModel(snapshot, { seerrConfigured: true, now: NOW }),
        16 / 9,
      );
      return new Map(
        [...layout.containerField.entries()].map(([name, geom]) => [
          name,
          `${geom.center.x.toFixed(6)},${geom.center.y.toFixed(6)}`,
        ]),
      );
    };
    const baselineCenters = centersOf(baseline);

    const mutate = (
      change: (c: import("@/lib/types").DockerContainerTelemetry) => void,
      name = "sonarr",
    ) => {
      const snapshot = makeFakeSnapshot("active", NOW);
      change(snapshot.telemetry.docker.value!.containers.find((c) => c.name === name)!);
      return centersOf(snapshot);
    };

    // CPU null → confirmed idle → hot: every center identical.
    expect(mutate((c) => (c.cpuFraction = null))).toEqual(baselineCenters);
    expect(mutate((c) => (c.cpuFraction = 0))).toEqual(baselineCenters);
    expect(mutate((c) => (c.cpuFraction = 1.8))).toEqual(baselineCenters);
    // Memory changing by two orders of magnitude.
    expect(mutate((c) => (c.memoryBytes = 12 * 1024 ** 3))).toEqual(baselineCenters);
    // I/O null → very active (halos are not layout obstacles).
    expect(
      mutate((c) => {
        c.netRxBps = 90_000_000;
        c.netTxBps = 90_000_000;
        c.blockReadBps = 120_000_000;
        c.blockWriteBps = 120_000_000;
      }),
    ).toEqual(baselineCenters);
    // Health / state changes.
    expect(
      mutate((c) => {
        c.health = "unhealthy";
        c.state = "exited";
      }),
    ).toEqual(baselineCenters);
  });

  it("prioritizes unhealthy, unknown, and hot containers over alphabetical order at the budget", () => {
    const snapshot = makeFakeSnapshot("active", NOW);
    const docker = snapshot.telemetry.docker.value!;
    const base = docker.containers[0]!;
    const idle = (index: number): typeof base => ({
      ...base,
      name: `container-${String(index).padStart(3, "0")}`,
      state: "running",
      health: null,
      cpuFraction: 0.01,
      memoryBytes: 128 * 1024 ** 2,
      netRxBps: 1_000,
      netTxBps: 1_000,
      blockReadBps: 0,
      blockWriteBps: 0,
    });
    // 113 idle containers, then three attention-worthy ones whose names sort
    // LAST — a first-96-alphabetical rule would hide exactly these.
    docker.containers = [
      ...Array.from({ length: 113 }, (_, i) => idle(i)),
      { ...idle(113), name: "zz-exited", state: "exited" as const, health: "unhealthy" as const },
      { ...idle(114), name: "zz-unknown", state: "unknown" as const },
      { ...idle(115), name: "zz-hot", cpuFraction: 3.2, memoryBytes: 9 * 1024 ** 3 },
    ];
    docker.total = docker.containers.length;
    docker.running = docker.containers.length - 1;

    const layout = computeLayout(
      buildSceneModel(snapshot, { seerrConfigured: true, now: NOW }),
      16 / 9,
    );
    expect(layout.containerField.size).toBe(MAX_RENDERED_CONTAINERS);
    expect(layout.containerOverflowCount).toBe(116 - MAX_RENDERED_CONTAINERS);
    expect(layout.containerOverflow).not.toBeNull();
    // The attention-worthy bodies are all rendered despite sorting last.
    expect(layout.containerField.has("zz-exited")).toBe(true);
    expect(layout.containerField.has("zz-unknown")).toBe(true);
    expect(layout.containerField.has("zz-hot")).toBe(true);
    // …which means some alphabetically-earlier idle container yielded.
    expect(layout.containerField.has("container-112")).toBe(false);
  });

  it("uses a truthful overflow body instead of silently truncating large populations", () => {
    const snapshot = makeFakeSnapshot("active", NOW);
    const docker = snapshot.telemetry.docker.value!;
    const base = docker.containers[0]!;
    docker.containers = Array.from({ length: MAX_RENDERED_CONTAINERS + 9 }, (_, index) => ({
      ...base,
      name: `container-${String(index).padStart(3, "0")}`,
    }));
    docker.total = docker.containers.length;
    docker.running = docker.containers.length;
    const large = buildSceneModel(snapshot, { seerrConfigured: true, now: NOW });
    const layout = computeLayout(large, 16 / 9);
    expect(large.docker.containers).toHaveLength(MAX_RENDERED_CONTAINERS + 9);
    expect(layout.containerField.size).toBe(MAX_RENDERED_CONTAINERS);
    expect(layout.containerOverflowCount).toBe(9);
    expect(layout.containerOverflow).not.toBeNull();
  });

  it("the real-scale fixture is a representative 44-container population, fully rendered", () => {
    expect(REAL_FIELD_CONTAINER_COUNT).toBe(44);
    const m = model("container-field-real");
    expect(m.docker.containers).toHaveLength(44);

    // Representative distribution, not 44 clones:
    const hot = m.docker.containers.filter((c) => (c.cpuFraction ?? 0) >= 0.5);
    const idle = m.docker.containers.filter(
      (c) => c.cpuFraction !== null && c.cpuFraction < 0.05,
    );
    const noStats = m.docker.containers.filter((c) => c.metricCoverage === "unavailable");
    const partial = m.docker.containers.filter((c) => c.metricCoverage === "partial");
    expect(hot.length).toBeGreaterThanOrEqual(3);
    expect(idle.length).toBeGreaterThanOrEqual(12);
    expect(noStats.length).toBeGreaterThanOrEqual(3);
    expect(partial.length).toBeGreaterThanOrEqual(2);
    expect(m.docker.containers.some((c) => c.bad)).toBe(true);
    expect(m.docker.containers.some((c) => c.unverified)).toBe(true);
    expect(m.docker.containers.some((c) => (c.netRxBps ?? 0) > 1_000_000)).toBe(true);
    expect(m.docker.containers.some((c) => (c.blockWriteBps ?? 0) > 1_000_000)).toBe(true);

    // Under the 96-body budget the entire population renders — no overflow.
    const layout = computeLayout(m, 16 / 9);
    expect(layout.containerField.size).toBe(44);
    expect(layout.containerOverflowCount).toBe(0);
    expect(layout.containerOverflow).toBeNull();
    for (const geom of layout.containerField.values()) {
      expect(geom.center.x).toBeGreaterThan(0);
      expect(geom.center.x).toBeLessThan(layout.world.w);
      expect(geom.center.y).toBeGreaterThan(0);
      expect(geom.center.y).toBeLessThan(layout.world.h);
    }
  });

  it("the stress fixture exceeds the budget with a truthful overflow and no hidden attention", () => {
    expect(STRESS_FIELD_CONTAINER_COUNT).toBeGreaterThan(MAX_RENDERED_CONTAINERS);
    const m = model("container-field-stress");
    expect(m.docker.containers).toHaveLength(STRESS_FIELD_CONTAINER_COUNT);
    const layout = computeLayout(m, 16 / 9);
    expect(layout.containerField.size).toBe(MAX_RENDERED_CONTAINERS);
    expect(layout.containerOverflowCount).toBe(
      STRESS_FIELD_CONTAINER_COUNT - MAX_RENDERED_CONTAINERS,
    );
    // The alphabetically-last unhealthy/unknown workers must still render.
    expect(layout.containerField.has("zz-batch-failed")).toBe(true);
    expect(layout.containerField.has("zz-batch-unknown")).toBe(true);
    expect(layout.containerField.has("flaresolverr")).toBe(true);
    expect(layout.containerField.has("unpackerr")).toBe(true);
    // The hottest live workloads survive selection too.
    expect(layout.containerField.has("jellyfin")).toBe(true);
    for (const geom of layout.containerField.values()) {
      expect(geom.center.x).toBeGreaterThan(0);
      expect(geom.center.x).toBeLessThan(layout.world.w);
      expect(geom.center.y).toBeGreaterThan(0);
      expect(geom.center.y).toBeLessThan(layout.world.h);
    }
  });

  it("keeps the representative container field clear of primary bodies", () => {
    const layout = computeLayout(model("active"), 16 / 9);
    const primary = [
      ...layout.services.values(),
      ...layout.storage.values(),
      ...(layout.genericStorage ? [layout.genericStorage] : []),
    ];
    for (const container of layout.containerField.values()) {
      for (const body of primary) {
        expect(dist(container.center, body.center)).toBeGreaterThanOrEqual(
          body.atmosphereR + container.r + 12,
        );
      }
    }
  });

  it.each(VIEWPORTS)("keeps every body + label inside safe bounds at %ox", (vp) => {
    const m = model("active");
    const layout = computeLayout(m, vp.w / vp.h);
    const { w, h } = layout.world;
    for (const b of allBodies(layout)) {
      expect(b.center.x - b.atmosphereR).toBeGreaterThan(0);
      expect(b.center.x + b.atmosphereR).toBeLessThan(w);
      expect(b.center.y - b.atmosphereR).toBeGreaterThan(0);
      expect(b.center.y + b.atmosphereR).toBeLessThan(h);
    }
    for (const lb of buildLabels(m, layout, NOW)) {
      expect(lb.anchor.x - lb.box.w / 2).toBeGreaterThan(0);
      expect(lb.anchor.x + lb.box.w / 2).toBeLessThan(w);
      expect(lb.anchor.y).toBeGreaterThan(0);
      expect(lb.anchor.y + lb.box.h).toBeLessThan(h);
    }
    expect(h).toBe(WORLD_H);
  });

  it("labels never collide with each other", () => {
    for (const scenario of ["idle", "active", "zfs-degraded"] as const) {
      const m = model(scenario);
      const layout = computeLayout(m, VIEWPORTS[0]!.w / VIEWPORTS[0]!.h);
      const labels = buildLabels(m, layout, NOW);
      for (let i = 0; i < labels.length; i++) {
        for (let j = i + 1; j < labels.length; j++) {
          expect(
            labelsOverlap(labels[i]!, labels[j]!),
            `${labels[i]!.id} overlaps ${labels[j]!.id}`,
          ).toBe(false);
        }
      }
    }
  });

  it("does not explode with unknown/extra pools", () => {
    const snap = makeFakeSnapshot("idle", NOW);
    const pools = [
      ...snap.zfs.pools,
      ...[1, 2, 3, 4, 5].map((i) => testPool({ name: `extra${i}` })),
    ];
    const m = buildSceneModel(
      { ...snap, zfs: { pools } },
      { seerrConfigured: true, now: NOW },
    );
    const layout = computeLayout(m, 1.9);
    expect(layout.storage.size).toBe(pools.length);
    for (const b of layout.storage.values()) {
      expect(b.center.x).toBeGreaterThan(0);
      expect(b.center.x).toBeLessThan(layout.world.w);
      expect(b.center.y).toBeGreaterThan(0);
      expect(b.center.y).toBeLessThan(layout.world.h);
    }
  });
});

describe("flow routing geometry", () => {
  const scenarios = ["active", "downloads", "direct-play", "transcode"] as const;

  it.each(scenarios)("'%s': finite coords, ports on boundaries, core avoided", (scenario) => {
    const m = model(scenario);
    for (const vp of VIEWPORTS) {
      const layout = computeLayout(m, vp.w / vp.h);
      const geoms = routeFlows(layout, m.flows);
      expect(geoms.length).toBe(m.flows.length);
      for (const g of geoms) {
        // Finite everywhere.
        for (const p of g.path.points) {
          expect(Number.isFinite(p.x)).toBe(true);
          expect(Number.isFinite(p.y)).toBe(true);
        }
        // Ports terminate on their body boundary (+PORT_PAD), not inside, not
        // floating. Network-arc endpoints sit on the arc radius instead.
        const endpoints = [
          { port: g.ports.from, ep: g.flow.from },
          { port: g.ports.to, ep: g.flow.to },
        ];
        for (const { port, ep } of endpoints) {
          if (ep.kind === "network") {
            expect(
              Math.abs(dist(port, layout.networkArc.center) - layout.networkArc.r),
            ).toBeLessThan(0.5);
          } else {
            const body =
              ep.kind === "service"
                ? layout.services.get(ep.id)!
                : ep.kind === "pool"
                  ? layout.storage.get(ep.name) ?? layout.genericStorage!
                  : layout.genericStorage!;
            expect(Math.abs(dist(port, body.center) - (body.r + PORT_PAD))).toBeLessThan(0.5);
          }
        }
        // No route may pass through the compute star.
        for (const p of g.path.points) {
          expect(dist(p, layout.core.center)).toBeGreaterThan(layout.core.boundaryR - 0.5);
        }
        // Clearance from every UNRELATED major body's atmosphere.
        for (const body of allBodies(layout)) {
          const related =
            (g.flow.from.kind === "service" && body.id === `service:${g.flow.from.id}`) ||
            (g.flow.to.kind === "service" && body.id === `service:${g.flow.to.id}`) ||
            (g.flow.from.kind === "pool" && body.id === `pool:${g.flow.from.name}`) ||
            (g.flow.to.kind === "pool" && body.id === `pool:${g.flow.to.name}`) ||
            (g.flow.from.kind === "storage" && body.id === "storage:generic") ||
            (g.flow.to.kind === "storage" && body.id === "storage:generic");
          if (related) continue;
          expect(
            pathClearance(g.path, body),
            `${g.flow.id} clips ${body.id} (${scenario})`,
          ).toBeGreaterThan(2);
        }
      }
    }
  });

  it("routing is deterministic", () => {
    const m = model("active");
    const layout = computeLayout(m, 1.94);
    const a = routeFlows(layout, m.flows);
    const b = routeFlows(layout, m.flows);
    expect(JSON.stringify(a.map((g) => g.path.points))).toBe(
      JSON.stringify(b.map((g) => g.path.points)),
    );
  });

  it("sweepThrough picks the direction containing the waypoint", () => {
    // From 170° to -10° via the bottom (90°): angles DECREASE (170→90→-10).
    const s1 = sweepThrough((170 * Math.PI) / 180, (-10 * Math.PI) / 180, Math.PI / 2);
    expect(s1).toBeLessThan(0);
    // Same endpoints via the top (-90° ≡ 270°): angles increase through 270°.
    const s2 = sweepThrough((170 * Math.PI) / 180, (-10 * Math.PI) / 180, -Math.PI / 2);
    expect(s2).toBeGreaterThan(0);
    expect(Math.abs(Math.abs(s1) + Math.abs(s2) - Math.PI * 2)).toBeLessThan(1e-9);
  });
});

describe("gateway + dormant topology", () => {
  it("every network-terminated flow passes through the ONE gateway aperture", () => {
    for (const scenario of ["downloads", "seeding", "direct-play", "active"] as const) {
      const m = model(scenario);
      const layout = computeLayout(m, VIEWPORTS[0]!.w / VIEWPORTS[0]!.h);
      for (const g of routeFlows(layout, m.flows)) {
        const endpoints = [
          { port: g.ports.from, ep: g.flow.from },
          { port: g.ports.to, ep: g.flow.to },
        ];
        for (const { port, ep } of endpoints) {
          if (ep.kind !== "network") continue;
          expect(dist(port, layout.gateway.point)).toBeLessThan(0.5);
        }
      }
    }
  });

  it("dormant routes exist for the configured topology and stay finite + clear", () => {
    const m = model("idle");
    const layout = computeLayout(m, VIEWPORTS[0]!.w / VIEWPORTS[0]!.h);
    const routes = dormantRoutes(layout, m);
    // WAN, staging-storage, 2× control, playback, egress for the demo stack.
    expect(routes.length).toBe(6);
    for (const g of routes) {
      for (const p of g.path.points) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
      for (const p of g.path.points) {
        expect(dist(p, layout.core.center)).toBeGreaterThan(layout.core.boundaryR - 0.5);
      }
    }
  });

  it("unconfigured services contribute NO dormant routes (quiet, not fake)", () => {
    const m = model("unconfigured");
    const layout = computeLayout(m, VIEWPORTS[0]!.w / VIEWPORTS[0]!.h);
    expect(dormantRoutes(layout, m)).toHaveLength(0);
  });
});

describe("flow inspection text", () => {
  it("keeps measured flow copy concise while accessibility retains evidence", () => {
    const flows = deriveFlows(makeFakeSnapshot("seeding", NOW), NOW);
    const wan = flows.find((f) => f.kind === "wan-transfer")!;
    const d = describeFlow(wan, NOW);
    expect(d.title).toBe("network → qBittorrent");
    expect(d.value).toMatch(/in \d/);
    expect(d.value).toMatch(/out \d/);
    expect(`${d.title}\n${d.value}`).not.toMatch(/measured|updated|derived/);
    expect(d.accessible).toContain("measured");
    expect(d.accessible).toContain("source updated");
    expect(d.detail).toContain("qBittorrent");
  });

  it("a state-only data flow admits its byte rate is unavailable", () => {
    const snap = makeFakeSnapshot("direct-play", NOW);
    const noBitrate = {
      ...snap,
      jellyfinContainer: null,
      jellyfin: {
        ...snap.jellyfin,
        sessions: snap.jellyfin.sessions.map((s) => ({ ...s, rate: null })),
      },
    };
    const playback = deriveFlows(noBitrate, NOW).find((f) => f.kind === "playback")!;
    const d = describeFlow(playback, NOW);
    expect(d.title).toBe("DataStore → Jellyfin");
    expect(d.value).toBe("rate unknown");
    expect(d.accessible).toContain("state evidence only");
  });

  it("shows a concise lower bound for partial session coverage", () => {
    const snap = makeFakeSnapshot("multi-session", NOW);
    const partial = {
      ...snap,
      jellyfinContainer: null,
      jellyfin: {
        ...snap.jellyfin,
        sessions: snap.jellyfin.sessions.map((session, index) =>
          index === 0 ? { ...session, rate: null } : session,
        ),
      },
    };
    const egress = deriveFlows(partial, NOW).find((flow) => flow.kind === "egress")!;
    const description = describeFlow(egress, NOW);
    expect(description.title).toBe("Jellyfin → network");
    expect(description.value).toBe("1.2 MB/s + 1 unknown");
    expect(description.accessible).toContain("partial coverage");
  });

  it("uses endpoint copy for control signals", () => {
    const control = deriveFlows(makeFakeSnapshot("downloads", NOW), NOW).find(
      (flow) => flow.kind === "control" && flow.from.kind === "service" && flow.from.id === "radarr",
    )!;
    expect(describeFlow(control, NOW)).toMatchObject({
      title: "Radarr → qBittorrent",
      value: "orchestrating",
    });
  });

  it("a stale flow says so", () => {
    const snap = makeFakeSnapshot("downloads", NOW);
    const stale = {
      ...snap,
      health: snap.health.map((h) =>
        h.id === "qbittorrent" ? { ...h, lastSuccessAt: NOW - 10 * 60_000 } : h,
      ),
    };
    const wan = deriveFlows(stale, NOW).find((f) => f.kind === "wan-transfer")!;
    expect(describeFlow(wan, NOW).value).toMatch(/^stale /);
  });
});

describe("viewport-aware flow tooltip placement", () => {
  const viewport = { w: 320, h: 180 };
  const tooltip = { w: 120, h: 54 };

  it("flips and clamps on every viewport edge", () => {
    expect(placeTooltip({ x: 2, y: 2 }, tooltip, viewport)).toEqual({ left: 16, top: 16 });
    expect(placeTooltip({ x: 318, y: 2 }, tooltip, viewport)).toEqual({ left: 184, top: 16 });
    expect(placeTooltip({ x: 2, y: 178 }, tooltip, viewport)).toEqual({ left: 16, top: 110 });
    expect(placeTooltip({ x: 318, y: 178 }, tooltip, viewport)).toEqual({ left: 184, top: 110 });
  });
});

describe("motion honesty (PLA-273)", () => {
  it("stale pool I/O releases surface shimmer to zero — never keeps animating", () => {
    const motion = new SceneMotion();
    const live = model("downloads");
    motion.applyModel(live);
    motion.advance(0);
    motion.advance(4_000);
    expect(motion.storageIoOf("NVME")).toBeGreaterThan(0);
    // Same values, but the disk domain went stale.
    const staleModel = {
      ...live,
      storage: live.storage.map((p) => ({ ...p, ioFreshness: "stale" as const })),
    };
    motion.applyModel(staleModel);
    for (let t = 5_000; t < 40_000; t += 1_000) motion.advance(t);
    expect(motion.storageIoOf("NVME")).toBeLessThan(0.02);
  });

  it("unknown pool I/O (null) never produces shimmer", () => {
    const motion = new SceneMotion();
    const m = model("downloads");
    const unknown = {
      ...m,
      storage: m.storage.map((p) => ({
        ...p,
        readBps: null,
        writeBps: null,
        ioFreshness: "unavailable" as const,
      })),
    };
    motion.applyModel(unknown);
    motion.advance(0);
    motion.advance(10_000);
    expect(motion.storageIoOf("NVME")).toBe(0);
    expect(motion.storageIoOf("DataStore")).toBe(0);
  });

  it("stale flows hold a non-excited ghost while removed flows release", () => {
    const motion = new SceneMotion();
    const live = model("downloads");
    motion.applyModel(live);
    for (let t = 0; t <= 6_000; t += 500) motion.advance(t);
    const wan = motion.liveFlows().find((f) => f.obs.kind === "wan-transfer")!;
    expect(wan.width).toBeGreaterThan(1);
    expect(wan.activity).toBeGreaterThan(0.5);

    const staleModel = {
      ...live,
      flows: live.flows.map((f) => ({ ...f, freshness: "stale" as const })),
    };
    motion.applyModel(staleModel);
    for (let t = 7_000; t <= 30_000; t += 1_000) motion.advance(t);
    const ghost = motion.liveFlows().find((f) => f.obs.kind === "wan-transfer")!;
    expect(ghost.width).toBeGreaterThan(1);
    expect(ghost.activity).toBeLessThan(0.5);
    expect(flowOverlayIsLive(ghost)).toBe(false);

    motion.applyModel({ ...live, flows: [] });
    for (let t = 31_000; t <= 90_000; t += 1_000) motion.advance(t);
    expect(motion.liveFlows().find((f) => f.obs.kind === "wan-transfer")).toBeUndefined();
  });

  it("control-plane flows never acquire width from anything", () => {
    const motion = new SceneMotion();
    motion.applyModel(model("downloads"));
    for (let t = 0; t <= 8_000; t += 500) motion.advance(t);
    for (const f of motion.liveFlows()) {
      if (f.obs.plane === "control") {
        expect(f.width).toBe(0);
        expect(f.activity).toBeGreaterThan(0.5); // present as a signal instead
      }
    }
  });

  it("snapToTargets lands exactly on targets for frozen/reduced-motion frames", () => {
    const motion = new SceneMotion();
    motion.applyModel(model("downloads"));
    motion.snapToTargets(NOW);
    const wan = motion.liveFlows().find((f) => f.obs.kind === "wan-transfer")!;
    expect(wan.width).toBeGreaterThan(4); // 11.7 MB/s ⇒ mid-range width, instantly
  });

  it("stale network telemetry releases gateway excitation to zero", () => {
    const motion = new SceneMotion();
    const live = model("downloads");
    motion.applyModel(live);
    for (let t = 0; t <= 6_000; t += 500) motion.advance(t);
    expect(motion.rxNorm + motion.txNorm).toBeGreaterThan(0.01);

    motion.applyModel({
      ...live,
      network: { ...live.network, status: "stale" as const },
    });
    for (let t = 7_000; t <= 30_000; t += 1_000) motion.advance(t);
    expect(motion.rxNorm).toBeLessThan(0.02);
    expect(motion.txNorm).toBeLessThan(0.02);
  });

  it("stale host telemetry freezes displayed cpu and gpu values instead of animating toward new targets", () => {
    const motion = new SceneMotion();
    const live = model("transcode");
    motion.applyModel(live);
    for (let t = 0; t <= 6_000; t += 500) motion.advance(t);
    const frozenLoad = motion.totalLoad;
    const frozenGpu = motion.gpuLoad;
    const frozenPerCore = [...motion.perCore];

    motion.applyModel({
      ...live,
      core: {
        ...live.core,
        status: "stale" as const,
        perCore: live.core.perCore.map(() => 0),
        totalFraction: 0,
        gpuFraction: 0,
      },
    });
    for (let t = 7_000; t <= 30_000; t += 1_000) motion.advance(t);

    expect(motion.totalLoad).toBeCloseTo(frozenLoad, 4);
    expect(motion.gpuLoad).toBeCloseTo(frozenGpu, 4);
    expect(motion.perCore).toEqual(
      expect.arrayContaining(frozenPerCore.map((value) => expect.closeTo(value, 4))),
    );
  });
});

describe("render helpers", () => {
  it("marks only present live overlays as excitable", () => {
    const live = new SceneMotion();
    live.applyModel(model("downloads"));
    live.snapToTargets(NOW);
    const wan = live.liveFlows().find((f) => f.obs.kind === "wan-transfer")!;
    expect(flowOverlayIsLive(wan)).toBe(true);
    expect(flowOverlayIsLive({ ...wan, present: false })).toBe(false);
    expect(flowOverlayIsLive({ ...wan, obs: { ...wan.obs, freshness: "stale" } })).toBe(false);
  });

  it("uses the reverse token on both endpoints for reverse-only tunnels", () => {
    expect(
      tunnelEndpointTokens([{ direction: "reverse", role: "egress" }], "flow-in"),
    ).toEqual({ from: "flow-out", to: "flow-out" });
    expect(
      tunnelEndpointTokens(
        [
          { direction: "forward", role: "ingress" },
          { direction: "reverse", role: "egress" },
        ],
        "flow-in",
      ),
    ).toEqual({ from: "flow-out", to: "flow-in" });
  });

  it("keeps the shared tunnel body bidirectional when near-equal rates cross", () => {
    const channels = (forwardWidth: number, reverseWidth: number) => [
      { direction: "forward" as const, width: forwardWidth, bps: 10_000_000 },
      { direction: "reverse" as const, width: reverseWidth, bps: 9_000_000 },
    ];
    expect(tunnelBodyIsBidirectional(channels(6.4, 6.2))).toBe(true);
    expect(tunnelBodyIsBidirectional(channels(6.2, 6.4))).toBe(true);
  });
});

describe("background determinism", () => {
  it("is identical across builds (fixed seed)", () => {
    expect(JSON.stringify(buildBackground())).toBe(JSON.stringify(buildBackground()));
  });
});

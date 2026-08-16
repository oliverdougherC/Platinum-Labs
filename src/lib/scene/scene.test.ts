import { describe, expect, it } from "vitest";
import { buildSceneModel, capacityTone } from "@/lib/scene/model";
import { computeLayout, WORLD_H, type SceneLayout } from "@/lib/scene/layout";
import { buildLabels, describeFlow, labelsOverlap } from "@/lib/scene/labels";
import {
  flowOverlayIsLive,
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
import { SceneMotion } from "@/lib/scene/motion";
import { dist } from "@/lib/scene/geom";
import { buildBackground } from "@/lib/scene/background";
import { appConfig } from "@/lib/config";
import { deriveFlows } from "@/lib/topology/activity";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";
import { FAKE_CORE_COUNT } from "@/lib/fake/telemetry";
import { testPool } from "@/lib/test/factories";
import type { BodyGeom } from "@/lib/scene/layout";
import type { SceneModel } from "@/lib/scene/model";

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
});

describe("layout determinism and bounds", () => {
  it("same model + same aspect ⇒ identical layout", () => {
    const m = model("active");
    const a = computeLayout(m, 1920 / 992);
    const b = computeLayout(m, 1920 / 992);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
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
  it("describes a measured flow with evidence, rates, and freshness", () => {
    const flows = deriveFlows(makeFakeSnapshot("seeding", NOW), NOW);
    const wan = flows.find((f) => f.kind === "wan-transfer")!;
    const d = describeFlow(wan, NOW);
    expect(d.summary).toContain("measured");
    expect(d.summary).toMatch(/in \d/);
    expect(d.summary).toMatch(/out \d/);
    expect(d.summary).toContain("updated");
    expect(d.detail).toContain("qBittorrent");
  });

  it("a state-only data flow admits its byte rate is unavailable", () => {
    const snap = makeFakeSnapshot("direct-play", NOW);
    const noBitrate = {
      ...snap,
      jellyfin: {
        ...snap.jellyfin,
        sessions: snap.jellyfin.sessions.map((s) => ({ ...s, bitrateBps: null })),
      },
    };
    const playback = deriveFlows(noBitrate, NOW).find((f) => f.kind === "playback")!;
    const d = describeFlow(playback, NOW);
    expect(d.summary).toContain("state confirmed");
    expect(d.summary).toContain("byte rate unavailable");
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
    expect(describeFlow(wan, NOW).summary).toContain("stale");
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

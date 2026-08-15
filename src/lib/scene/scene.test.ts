import { describe, expect, it } from "vitest";
import { buildSceneModel, capacityTone } from "@/lib/scene/model";
import { computeLayout, WORLD_H, type SceneLayout } from "@/lib/scene/layout";
import { buildLabels, labelsOverlap } from "@/lib/scene/labels";
import { pathClearance, PORT_PAD, routeFlows, sweepThrough } from "@/lib/scene/routing";
import { dist } from "@/lib/scene/geom";
import { buildBackground } from "@/lib/scene/background";
import { appConfig } from "@/lib/config";
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

describe("background determinism", () => {
  it("is identical across builds (fixed seed)", () => {
    expect(JSON.stringify(buildBackground())).toBe(JSON.stringify(buildBackground()));
  });
});

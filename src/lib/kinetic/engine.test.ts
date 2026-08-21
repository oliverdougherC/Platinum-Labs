import { describe, expect, it } from "vitest";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";
import type { DashboardSnapshot } from "@/lib/types";
import { buildKineticScene, type KineticScene } from "./model";
import { buildKineticLayout, type KineticLayout } from "./layout";
import {
  KineticEngine,
  FLOW_MISSING_GRACE_SECONDS,
  MAX_FRAME_DELTA_SECONDS,
  MAX_PARTICLE_SLOTS,
  PARTICLE_SPEED,
  slotPosition,
  targetSlotCount,
} from "./engine";

const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);

function sceneAndLayout(
  scenario: Parameters<typeof makeFakeSnapshot>[0],
  mutate?: (snapshot: DashboardSnapshot) => void,
): { scene: KineticScene; layout: KineticLayout } {
  const snapshot = structuredClone(makeFakeSnapshot(scenario, NOW));
  mutate?.(snapshot);
  const scene = buildKineticScene(snapshot, { now: NOW, seerrConfigured: true });
  return { scene, layout: buildKineticLayout(scene, 1920, 1080) };
}

function setDownloadRate(snapshot: DashboardSnapshot, bps: number): void {
  snapshot.acquisition.rollup.aggregateRateBps = bps;
}

/** Advance the engine with regular 16 ms frames for `seconds`. */
function run(engine: KineticEngine, fromMs: number, seconds: number): number {
  let at = fromMs;
  const frames = Math.ceil((seconds * 1000) / 16);
  for (let i = 0; i < frames; i++) {
    at += 16;
    engine.frame(at);
  }
  return at;
}

function wanVisual(engine: KineticEngine) {
  const visual = engine
    .visualState()
    .flows.find((f) => f.flow.kind === "wan-transfer");
  if (!visual) throw new Error("no wan-transfer visual");
  return visual;
}

function backgroundVisual(engine: KineticEngine) {
  const visual = engine
    .visualState()
    .flows.find((f) => f.flow.kind === "background-transfer");
  if (!visual) throw new Error("no background-transfer visual");
  return visual;
}

function playbackVisual(engine: KineticEngine) {
  const visual = engine
    .visualState()
    .flows.find((flow) => flow.flow.kind === "playback");
  if (!visual) throw new Error("no playback visual");
  return visual;
}

describe("KineticEngine phase continuity", () => {
  it("keeps visual time monotonic and phase continuous across telemetry target updates", () => {
    const a = sceneAndLayout("downloads", (s) => setDownloadRate(s, 10_000_000));
    const engine = new KineticEngine(0);
    engine.syncTargets(a.scene, a.layout);
    let at = run(engine, 0, 3);
    const before = wanVisual(engine);
    const seedBefore = before.channels[0]!.seed;
    const tBefore = engine.now();
    const posBefore = slotPosition(seedBefore, 0, tBefore, before.path.total);

    // A normal 2-second telemetry update changes the rate target only.
    const b = sceneAndLayout("downloads", (s) => setDownloadRate(s, 40_000_000));
    engine.syncTargets(b.scene, b.layout);
    at += 16;
    engine.frame(at);

    const after = wanVisual(engine);
    // Same visual object identity: the flow was updated, not recreated.
    expect(after).toBe(before);
    expect(after.channels[0]!.seed).toBe(seedBefore);
    // Time advanced by exactly one bounded frame; no epoch reset.
    expect(engine.now()).toBeCloseTo(tBefore + 0.016, 6);
    // The particle advanced by speed × dt — no jump backward, no restart.
    const posAfter = slotPosition(seedBefore, 0, engine.now(), after.path.total);
    const expected =
      (posBefore + (0.016 * PARTICLE_SPEED) / after.path.total) % 1;
    expect(posAfter).toBeCloseTo(expected, 6);
  });

  it("eases a rate change instead of snapping (10 → 40 → 18 MB/s)", () => {
    const engine = new KineticEngine(0);
    const at10 = sceneAndLayout("downloads", (s) => setDownloadRate(s, 10_000_000));
    engine.syncTargets(at10.scene, at10.layout);
    let at = run(engine, 0, 4);
    expect(wanVisual(engine).rate).toBeCloseTo(10_000_000, -4);

    const at40 = sceneAndLayout("downloads", (s) => setDownloadRate(s, 40_000_000));
    engine.syncTargets(at40.scene, at40.layout);
    at += 16;
    engine.frame(at);
    const mid = wanVisual(engine).rate;
    expect(mid).toBeGreaterThan(10_000_000);
    expect(mid).toBeLessThan(40_000_000 * 0.5);
    at = run(engine, at, 2);
    expect(wanVisual(engine).rate).toBeCloseTo(40_000_000, -5);

    const at18 = sceneAndLayout("downloads", (s) => setDownloadRate(s, 18_000_000));
    engine.syncTargets(at18.scene, at18.layout);
    at += 16;
    engine.frame(at);
    const down = wanVisual(engine).rate;
    expect(down).toBeLessThan(40_000_000);
    expect(down).toBeGreaterThan(18_000_000);
  });

  it("changes particle density by fading slots, never relocating visible ones", () => {
    const engine = new KineticEngine(0);
    const slow = sceneAndLayout("downloads", (s) => setDownloadRate(s, 2_000_000));
    engine.syncTargets(slow.scene, slow.layout);
    let at = run(engine, 0, 4);
    const visual = wanVisual(engine);
    const channel = visual.channels[0]!;
    const slowCount = targetSlotCount(visual.path.total, 2_000_000);
    const visibleBefore = channel.slotAlphas.filter((a) => a > 0.9).length;
    expect(visibleBefore).toBe(slowCount);

    const fast = sceneAndLayout("downloads", (s) => setDownloadRate(s, 80_000_000));
    engine.syncTargets(fast.scene, fast.layout);
    at += 16;
    engine.frame(at);
    // Previously visible slots never dip while density rises; new slots are
    // still fading in.
    for (let i = 0; i < slowCount; i++) {
      expect(channel.slotAlphas[i]).toBeGreaterThan(0.9);
    }
    const newSlot = channel.slotAlphas[slowCount + 1];
    if (newSlot !== undefined) {
      expect(newSlot).toBeGreaterThan(0);
      expect(newSlot).toBeLessThan(0.5);
    }
    run(engine, at, 3);
    const fastCount = targetSlotCount(visual.path.total, 80_000_000);
    expect(channel.slotAlphas.filter((a) => a > 0.9).length).toBe(fastCount);
    expect(fastCount).toBeGreaterThan(slowCount);
    expect(fastCount).toBeLessThanOrEqual(MAX_PARTICLE_SLOTS);
  });

  it("starts terminal decay promptly when a download is confirmed complete", () => {
    const engine = new KineticEngine(0);
    const active = sceneAndLayout("downloads");
    const idle = sceneAndLayout("idle");
    engine.syncTargets(active.scene, active.layout);
    let at = run(engine, 0, 3);
    const before = wanVisual(engine);
    const seedBefore = before.channels[0]!.seed;
    expect(before.presence).toBe(1);

    engine.syncTargets(idle.scene, idle.layout);
    expect(before.removed).toBe(true);
    expect(before.missingSinceMs).toBeNull();
    at = run(engine, at, 0.1);
    expect(before.presence).toBeLessThan(1);

    // A rapid restart during terminal decay still resumes on the same object;
    // no renderer grace is needed to preserve identity or particle phase.
    engine.syncTargets(active.scene, active.layout);
    at += 16;
    engine.frame(at);
    const back = wanVisual(engine);
    expect(back).toBe(before);
    expect(back.removed).toBe(false);
    expect(back.presence).toBeGreaterThan(0);
    expect(back.channels[0]!.seed).toBe(seedBefore);
    expect(
      engine.visualState().flows.filter((f) => f.flow.kind === "wan-transfer"),
    ).toHaveLength(1);
  });

  it("prunes a confirmed stop exactly once without a ghost", () => {
    const engine = new KineticEngine(0);
    const active = sceneAndLayout("downloads");
    const idle = sceneAndLayout("idle");
    engine.syncTargets(active.scene, active.layout);
    let at = run(engine, 0, 3);
    const before = wanVisual(engine);

    engine.syncTargets(idle.scene, idle.layout);
    expect(before.removed).toBe(true);
    at = run(engine, at, 0.2);
    expect(before.presence).toBeGreaterThan(0);
    expect(before.presence).toBeLessThan(1);

    at = run(engine, at, 2);
    expect(
      engine.visualState().flows.some((f) => f.flow.kind === "wan-transfer"),
    ).toBe(false);
    engine.syncTargets(idle.scene, idle.layout);
    run(engine, at, 1);
    expect(
      engine.visualState().flows.some((f) => f.flow.kind === "wan-transfer"),
    ).toBe(false);
  });

  it("bridges an ambiguous disk sample as stale, then resumes the same object", () => {
    const engine = new KineticEngine(0);
    const active = sceneAndLayout("background-copy");
    const missing = sceneAndLayout("background-copy-ambiguous");
    engine.syncTargets(active.scene, active.layout);
    let at = run(engine, 0, 3);
    const before = backgroundVisual(engine);
    const seed = before.channels[0]!.seed;

    engine.syncTargets(missing.scene, missing.layout);
    expect(backgroundVisual(engine)).toBe(before);
    expect(before.flow.treatment).toBe("stale");
    expect(before.flow.rateBps).toBeNull();
    expect(before.removed).toBe(false);
    at = run(engine, at, 2.2);
    expect(backgroundVisual(engine)).toBe(before);
    expect(before.presence).toBe(1);
    expect(before.staleW).toBeGreaterThan(0.9);
    expect(before.liveness).toBeLessThan(0.1);

    engine.syncTargets(missing.scene, missing.layout);
    expect(backgroundVisual(engine)).toBe(before);
    expect(before.removed).toBe(false);

    engine.syncTargets(active.scene, active.layout);
    at += 16;
    engine.frame(at);
    const resumed = backgroundVisual(engine);
    expect(resumed).toBe(before);
    expect(resumed.id).toBe(
      "background-transfer:pool:DataStore->pool:eSATA",
    );
    expect(resumed.channels[0]!.seed).toBe(seed);
    expect(resumed.removed).toBe(false);
    expect(resumed.flow.treatment).toBe("particles");
  });

  it("retains a background copy through concurrent playback ambiguity without restarting grace", () => {
    const engine = new KineticEngine(0);
    const active = sceneAndLayout("background-copy");
    const ambiguous = sceneAndLayout("background-copy-playback-ambiguous");
    const idle = sceneAndLayout("idle");
    engine.syncTargets(active.scene, active.layout);
    let at = run(engine, 0, 3);
    const before = backgroundVisual(engine);
    const seed = before.channels[0]!.seed;

    engine.syncTargets(ambiguous.scene, ambiguous.layout);
    expect(backgroundVisual(engine)).toBe(before);
    expect(before.flow.treatment).toBe("stale");
    expect(before.flow.rateBps).toBeNull();
    expect(before.flow.channels.every((channel) => channel.bytesPerSecond === null)).toBe(
      true,
    );
    const missingSince = before.missingSinceMs;
    at = run(engine, at, FLOW_MISSING_GRACE_SECONDS * 0.5);
    engine.syncTargets(ambiguous.scene, ambiguous.layout);
    expect(before.missingSinceMs).toBe(missingSince);

    engine.syncTargets(active.scene, active.layout);
    at += 16;
    engine.frame(at);
    const resumed = backgroundVisual(engine);
    expect(resumed).toBe(before);
    expect(resumed.channels[0]!.seed).toBe(seed);
    expect(resumed.flow.treatment).toBe("particles");
    expect(resumed.removed).toBe(false);

    engine.syncTargets(idle.scene, idle.layout);
    expect(before.removed).toBe(true);
    expect(before.missingSinceMs).toBeNull();
  });

  it("does not let an unavailable disk source masquerade as fresh traffic", () => {
    const engine = new KineticEngine(0);
    const active = sceneAndLayout("background-copy");
    const unavailable = sceneAndLayout("idle", (snapshot) => {
      snapshot.telemetry.disk = {
        status: "unavailable",
        value: null,
        updatedAt: null,
      };
    });
    engine.syncTargets(active.scene, active.layout);
    let at = run(engine, 0, 3);
    const before = backgroundVisual(engine);

    engine.syncTargets(unavailable.scene, unavailable.layout);
    expect(before.removed).toBe(true);
    expect(before.missingSinceMs).toBeNull();
    expect(before.flow.treatment).toBe("stale");
    expect(before.flow.rateBps).toBeNull();
    at = run(engine, at, 0.2);
    expect(before.presence).toBeLessThan(1);
    expect(before.liveness).toBeLessThan(1);
    expect(before.staleW).toBeGreaterThan(0);
    run(engine, at, 2);
    expect(
      engine.visualState().flows.some(
        (flow) => flow.flow.kind === "background-transfer",
      ),
    ).toBe(false);
  });

  it("freezes a residual connector-owned flow as unknown while it exits", () => {
    const engine = new KineticEngine(0);
    const active = sceneAndLayout("direct-play");
    const unavailable = sceneAndLayout("connector-unavailable");
    engine.syncTargets(active.scene, active.layout);
    let at = run(engine, 0, 3);
    const before = playbackVisual(engine);

    engine.syncTargets(unavailable.scene, unavailable.layout);
    expect(before.removed).toBe(true);
    expect(before.flow.treatment).toBe("stale");
    expect(before.flow.rateBps).toBeNull();
    expect(before.flow.channels.every((channel) => channel.bytesPerSecond === null)).toBe(
      true,
    );
    at = run(engine, at, 0.2);
    expect(before.presence).toBeLessThan(1);
    expect(before.liveness).toBeLessThan(1);
    expect(before.staleW).toBeGreaterThan(0);
    run(engine, at, 2);
    expect(
      engine.visualState().flows.some((flow) => flow.flow.kind === "playback"),
    ).toBe(false);
  });

  it("expires the grace by monotonic wall time when reduced motion snaps frames", () => {
    const engine = new KineticEngine(0);
    const active = sceneAndLayout("background-copy");
    const missing = sceneAndLayout("background-copy-ambiguous");
    engine.syncTargets(active.scene, active.layout, { snap: true, nowMs: 0 });
    const before = backgroundVisual(engine);

    engine.syncTargets(missing.scene, missing.layout, {
      snap: true,
      nowMs: 2_000,
    });
    expect(backgroundVisual(engine)).toBe(before);

    engine.syncTargets(missing.scene, missing.layout, {
      snap: true,
      nowMs: 2_000 + FLOW_MISSING_GRACE_SECONDS * 1000 + 1,
    });
    expect(
      engine.visualState().flows.some(
        (flow) => flow.flow.kind === "background-transfer",
      ),
    ).toBe(false);
  });

  it("clamps enormous scheduling gaps to one bounded step", () => {
    const engine = new KineticEngine(0);
    const active = sceneAndLayout("downloads");
    engine.syncTargets(active.scene, active.layout);
    engine.frame(16);
    const before = engine.now();
    engine.frame(16 + 30_000); // a 30-second pause
    expect(engine.now() - before).toBeLessThanOrEqual(MAX_FRAME_DELTA_SECONDS + 1e-9);
    // And time never runs backward.
    engine.frame(16 + 30_000 - 5);
    expect(engine.now()).toBeGreaterThanOrEqual(before);
  });

  it("keeps particle state bounded under the stress fixture", () => {
    const engine = new KineticEngine(0);
    const stress = sceneAndLayout("container-field-stress");
    engine.syncTargets(stress.scene, stress.layout);
    run(engine, 0, 2);
    const counts = engine.debugCounts();
    expect(counts.visibleParticles).toBeLessThanOrEqual(
      counts.flows * 2 * MAX_PARTICLE_SLOTS,
    );
    expect(counts.flows).toBeLessThanOrEqual(stress.scene.flows.length);
    expect(counts.cells).toBeLessThanOrEqual(120);
  });

  it("freezes a live background pool bridge without particles or pool excitation when it becomes stale", () => {
    const live = sceneAndLayout("background-copy");
    const stale = sceneAndLayout("background-copy-stale");
    const engine = new KineticEngine(0);
    engine.syncTargets(live.scene, live.layout, { snap: true });
    const before = engine
      .visualState()
      .flows.find((flow) => flow.flow.kind === "background-transfer")!;
    const liveRate = before.rate;
    expect(before.liveness).toBe(1);
    expect(before.channels.some((channel) => channel.slotAlphas.some((alpha) => alpha > 0))).toBe(true);

    engine.syncTargets(stale.scene, stale.layout, { snap: true });
    const frozen = engine
      .visualState()
      .flows.find((flow) => flow.flow.kind === "background-transfer")!;
    expect(frozen).toBe(before);
    expect(frozen.flow.treatment).toBe("stale");
    expect(frozen.rate).toBe(liveRate);
    expect(frozen.liveness).toBe(0);
    expect(frozen.channels.every((channel) => channel.slotAlphas.every((alpha) => alpha === 0))).toBe(true);
    expect(engine.visualState().strata.every((pool) => pool.io === 0)).toBe(true);
    expect(engine.animating()).toBe(false);
  });

  it("settles and parks after transitions complete", () => {
    const engine = new KineticEngine(0);
    const quiet = sceneAndLayout("idle");
    engine.syncTargets(quiet.scene, quiet.layout);
    run(engine, 0, 2);
    expect(engine.settled()).toBe(true);
    expect(engine.animating()).toBe(false);

    const active = sceneAndLayout("downloads");
    engine.syncTargets(active.scene, active.layout);
    expect(engine.animating()).toBe(true); // conservative until re-evaluated
    run(engine, 2000, 3);
    // Live particles keep the loop alive even when eases have settled.
    expect(engine.settled()).toBe(true);
    expect(engine.animating()).toBe(true);
  });

  it("snap produces deterministic visual state for the frozen harness", () => {
    const { scene, layout } = sceneAndLayout("active");
    const a = new KineticEngine(123);
    const b = new KineticEngine(456_789);
    a.syncTargets(scene, layout, { snap: true });
    b.syncTargets(scene, layout, { snap: true });
    const strip = (engine: KineticEngine) =>
      engine.visualState().flows.map((f) => ({
        id: f.id,
        presence: f.presence,
        liveness: f.liveness,
        rate: f.rate,
        seeds: f.channels.map((c) => c.seed),
        slots: f.channels.map((c) => c.slotAlphas.join(",")),
      }));
    expect(strip(a)).toEqual(strip(b));
  });
});

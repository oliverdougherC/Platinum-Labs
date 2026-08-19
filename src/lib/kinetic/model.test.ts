import { describe, expect, it } from "vitest";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";
import { FAKE_CPU_TOPOLOGY } from "@/lib/fake/telemetry";
import {
  buildKineticScene,
  cpuTopologyLabel,
  physicalCoreCells,
  rateIntensity,
} from "./model";
import { buildKineticLayout } from "./layout";
import { sceneAnimates } from "./render";

const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);

function scene(scenario: Parameters<typeof makeFakeSnapshot>[0]) {
  return buildKineticScene(makeFakeSnapshot(scenario, NOW), {
    now: NOW,
    seerrConfigured: true,
  });
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

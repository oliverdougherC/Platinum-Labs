import { describe, expect, it } from "vitest";
import { layoutTreemap, type TreemapRect } from "./treemap";

function overlap(a: TreemapRect, b: TreemapRect): number {
  return (
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  );
}

describe("layoutTreemap", () => {
  it("packs the full field with area exactly proportional to raw weights", () => {
    const bounds = { x: 100, y: 50, w: 800, h: 300 };
    const items = [
      { id: "half", weight: 50 },
      { id: "third", weight: 30 },
      { id: "fifth", weight: 20 },
    ];
    const rects = layoutTreemap(items, bounds);
    const fieldArea = bounds.w * bounds.h;
    expect(rects.reduce((sum, rect) => sum + rect.w * rect.h, 0)).toBeCloseTo(
      fieldArea,
      6,
    );
    for (const rect of rects) {
      const expected = items.find((item) => item.id === rect.id)!.weight / 100;
      expect((rect.w * rect.h) / fieldArea).toBeCloseTo(expected, 8);
      expect(rect.x).toBeGreaterThanOrEqual(bounds.x);
      expect(rect.y).toBeGreaterThanOrEqual(bounds.y);
      expect(rect.x + rect.w).toBeLessThanOrEqual(bounds.x + bounds.w + 1e-8);
      expect(rect.y + rect.h).toBeLessThanOrEqual(bounds.y + bounds.h + 1e-8);
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(overlap(rects[i]!, rects[j]!)).toBeLessThan(1e-7);
      }
    }
  });

  it("is deterministic and never invents area for zero, null-like, or invalid weights", () => {
    const items = [
      { id: "large", weight: 8 * 1024 ** 3 },
      { id: "small", weight: 64 * 1024 ** 2 },
      { id: "zero", weight: 0 },
      { id: "invalid", weight: Number.NaN },
    ];
    const a = layoutTreemap(items, { x: 0, y: 0, w: 1280, h: 240 });
    const b = layoutTreemap(items, { x: 0, y: 0, w: 1280, h: 240 });
    expect(a).toEqual(b);
    expect(a.map((rect) => rect.id).sort()).toEqual(["large", "small"]);
  });

  it("keeps identity branches stable while one workload gains memory", () => {
    const peers = Array.from({ length: 44 }, (_, index) => ({
      id: `container-${index}`,
      weight: index === 7 ? 1 : 2 + (index % 5),
    }));
    const before = layoutTreemap(peers, { x: 0, y: 0, w: 1536, h: 320 });
    const after = layoutTreemap(
      peers.map((item) => (item.id === "container-7" ? { ...item, weight: 80 } : item)),
      { x: 0, y: 0, w: 1536, h: 320 },
    );
    const beforeTile = before.find((rect) => rect.id === "container-7")!;
    const afterTile = after.find((rect) => rect.id === "container-7")!;
    expect(afterTile.w * afterTile.h).toBeGreaterThan(beforeTile.w * beforeTile.h * 20);
    expect(after.map((rect) => rect.id).sort()).toEqual(
      before.map((rect) => rect.id).sort(),
    );
  });

  it("keeps geometry continuous across tiny weight changes", () => {
    const items = Array.from({ length: 44 }, (_, index) => ({
      id: `container-${index}`,
      weight: 1 + (index % 7),
    }));
    items[7]!.weight = 3.28;
    const bounds = { x: 0, y: 0, w: 1536, h: 320 };
    const before = new Map(layoutTreemap(items, bounds).map((rect) => [rect.id, rect]));
    items[7]!.weight += 0.00001;
    const after = layoutTreemap(items, bounds);
    for (const rect of after) {
      const previous = before.get(rect.id)!;
      expect(Math.abs(rect.x - previous.x)).toBeLessThan(0.01);
      expect(Math.abs(rect.y - previous.y)).toBeLessThan(0.01);
      expect(Math.abs(rect.w - previous.w)).toBeLessThan(0.01);
      expect(Math.abs(rect.h - previous.h)).toBeLessThan(0.01);
    }
  });

  it("converges continuously when a near-zero member enters or leaves", () => {
    const bounds = { x: 0, y: 0, w: 1280, h: 300 };
    const base = Array.from({ length: 20 }, (_, index) => ({
      id: `container-${index}`,
      weight: 1 + (index % 5),
    }));
    const absent = new Map(layoutTreemap(base, bounds).map((rect) => [rect.id, rect]));
    const entering = layoutTreemap(
      [...base, { id: "new-container", weight: 1e-9 }],
      bounds,
    );
    for (const rect of entering.filter((item) => item.id !== "new-container")) {
      const previous = absent.get(rect.id)!;
      expect(Math.abs(rect.x - previous.x)).toBeLessThan(0.00001);
      expect(Math.abs(rect.y - previous.y)).toBeLessThan(0.00001);
      expect(Math.abs(rect.w - previous.w)).toBeLessThan(0.00001);
      expect(Math.abs(rect.h - previous.h)).toBeLessThan(0.00001);
    }
  });
});

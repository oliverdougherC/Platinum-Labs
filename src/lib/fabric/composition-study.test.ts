import { describe, expect, it } from "vitest";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";
import { buildFabricModel } from "@/lib/fabric/model";
import {
  buildFabricComposition,
  validateFabricComposition,
  type FabricCompositionId,
} from "@/lib/fabric/composition-study";

const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);

function modelFor(scenario: Parameters<typeof makeFakeSnapshot>[0]) {
  const activity = makeFakeSnapshot(scenario, NOW);
  const realScale = makeFakeSnapshot("container-field-real", NOW);
  return buildFabricModel({
    ...activity,
    telemetry: { ...activity.telemetry, docker: realScale.telemetry.docker },
  }, { now: NOW, seerrConfigured: true });
}

describe("fabric composition studies", () => {
  for (const id of ["A", "B", "C"] satisfies FabricCompositionId[]) {
    it(`${id} is deterministic, planar, balanced, and accounts for the real-scale population`, () => {
      const first = buildFabricComposition(modelFor("container-mixed"), id);
      const second = buildFabricComposition(modelFor("container-mixed"), id);
      expect(second).toEqual(first);
      expect(first.representedIds).toHaveLength(44);
      expect(first.summaryIds).toEqual(first.representedIds);
      expect(new Set(first.segments.map((segment) => segment.id)).size).toBe(first.segments.length);
      expect(first.logicalRoutes.every((route) => route.segmentIds.length > 0)).toBe(true);
      expect(validateFabricComposition(first)).toMatchObject({
        duplicateGeometry: [],
        segmentLabelIntersections: [],
        segmentNodeIntersections: [],
        textOverflow: [],
        unapprovedCrossings: [],
        longNetworkLabels: [],
        danglingSegments: [],
        missingPopulationIds: [],
        horizontallyBalanced: true,
        valid: true,
      });
    });
  }

  it("keeps the same physical graph across quiet, mixed, focus, and real-scale activity", () => {
    for (const id of ["A", "B", "C"] satisfies FabricCompositionId[]) {
      const geometries = ["idle", "container-mixed", "transcode", "relationship-map"].map((scenario) =>
        buildFabricComposition(modelFor(scenario as Parameters<typeof makeFakeSnapshot>[0]), id).segments.map((segment) => ({
          id: segment.id,
          plane: segment.plane,
          points: segment.points,
          labelBounds: segment.labelBounds,
        })),
      );
      expect(geometries.slice(1).every((geometry) => JSON.stringify(geometry) === JSON.stringify(geometries[0]))).toBe(true);
    }
  });

  it("aggregates logical contributors onto one physical segment per plane", () => {
    const scene = buildFabricComposition(modelFor("active"), "A");
    const physicalIds = new Set(scene.segments.map((segment) => segment.id));
    expect(scene.segments.filter((segment) => segment.id === "segment:wan-gateway")).toHaveLength(1);
    expect(scene.segments.filter((segment) => segment.id === "segment:control")).toHaveLength(1);
    expect(scene.segments.filter((segment) => segment.id === "segment:read")).toHaveLength(1);
    expect(scene.segments.filter((segment) => segment.id === "segment:write")).toHaveLength(1);
    expect(scene.logicalRoutes.flatMap((route) => route.segmentIds).every((id) => physicalIds.has(id))).toBe(true);
  });
});

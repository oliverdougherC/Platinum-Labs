import { describe, expect, it } from "vitest";
import { materializePort, type FabricPortSide } from "@/lib/fabric/ports";
import {
  countRouteCrossings,
  countRouteOverlaps,
  expandBounds,
  routeHitsPorts,
  routeIntersectsBounds,
  routeSceneBetweenPorts,
  type FabricRoute,
} from "@/lib/fabric/routing";

function port(id: string, x: number, y: number, side: FabricPortSide) {
  return materializePort(
    { id, nodeId: id.split(":")[0]!, kind: "network", side, offset: 0.5, label: id },
    { x, y, width: 40, height: 40 },
  );
}

function everySegmentIsOrthogonal(route: FabricRoute): boolean {
  return route.points.slice(1).every((point, index) => {
    const previous = route.points[index]!;
    return previous.x === point.x || previous.y === point.y;
  });
}

describe("fabric scene router", () => {
  it("is deterministic, orthogonal, and preserves exact materialized endpoints", () => {
    const from = port("source:network", 40, 120, "right");
    const to = port("target:network", 680, 340, "left");
    const request = {
      from,
      to,
      lanes: [
        { id: "lane:h", axis: "horizontal" as const, coordinate: 100, start: 0, end: 800, shared: true },
        { id: "lane:v", axis: "vertical" as const, coordinate: 620, start: 0, end: 500, shared: true },
      ],
    };
    const first = routeSceneBetweenPorts(request);
    const second = routeSceneBetweenPorts(request);

    expect(first).toEqual(second);
    expect(routeHitsPorts(first, from, to)).toBe(true);
    expect(everySegmentIsOrthogonal(first)).toBe(true);
  });

  it("avoids padded node and essential-text obstacles", () => {
    const from = port("source:network", 40, 180, "right");
    const to = port("target:network", 720, 180, "left");
    const moduleBounds = { x: 300, y: 120, width: 150, height: 120 };
    const text = { x: 500, y: 150, width: 110, height: 38 };
    const route = routeSceneBetweenPorts({
      from,
      to,
      obstacles: [
        { id: "module", bounds: moduleBounds, padding: 14 },
        { id: "essential-text", bounds: text, padding: 8 },
      ],
      lanes: [
        { id: "lane:upper", axis: "horizontal", coordinate: 92, start: 0, end: 820, ownerId: "data", shared: true },
        { id: "lane:lower", axis: "horizontal", coordinate: 272, start: 0, end: 820, ownerId: "data", shared: true },
      ],
      ownerId: "data",
    });

    expect(routeIntersectsBounds(route, expandBounds(moduleBounds, 14))).toBe(false);
    expect(routeIntersectsBounds(route, expandBounds(text, 8))).toBe(false);
    expect(everySegmentIsOrthogonal(route)).toBe(true);
  });

  it("leaves and enters through the declared port-side egress corridors", () => {
    const from = port("source:network", 40, 120, "bottom");
    const to = port("target:network", 480, 320, "top");
    const route = routeSceneBetweenPorts({ from, to });

    expect(route.points[1]!.x).toBe(from.center.x);
    expect(route.points[1]!.y).toBeGreaterThan(from.center.y);
    expect(route.points.at(-2)!.x).toBe(to.center.x);
    expect(route.points.at(-2)!.y).toBeLessThan(to.center.y);
  });

  it("marks intentional shared-trunk overlap with stable lane ownership", () => {
    const from = port("source:network", 40, 180, "right");
    const to = port("target:network", 700, 180, "left");
    const lane = { id: "trunk:network", axis: "horizontal" as const, coordinate: 200, start: 0, end: 800, ownerId: "network", shared: true };
    const first = routeSceneBetweenPorts({ from, to, lanes: [lane], ownerId: "network", allowSharedLaneIds: [lane.id] });
    const second = routeSceneBetweenPorts({ from, to, lanes: [lane], ownerId: "network", allowSharedLaneIds: [lane.id], priorRoutes: [first] });

    expect(second.laneIds).toContain(lane.id);
    expect(second.segments?.some((segment) => segment.laneId === lane.id && segment.shared)).toBe(true);
  });

  it("uses a reserved detour instead of crossing an existing route", () => {
    const horizontal = routeSceneBetweenPorts({
      from: port("west:network", 40, 180, "right"),
      to: port("east:network", 720, 180, "left"),
    });
    const verticalLane = { id: "lane:detour", axis: "vertical" as const, coordinate: 760, start: 0, end: 440, ownerId: "control", shared: false };
    const routed = routeSceneBetweenPorts({
      from: port("north:network", 380, 20, "bottom"),
      to: port("south:network", 380, 380, "top"),
      lanes: [verticalLane],
      ownerId: "control",
      priorRoutes: [horizontal],
      crossingPenalty: 1_000,
    });

    expect(countRouteCrossings(routed, [horizontal])).toBe(0);
    expect(routed.laneIds).toContain(verticalLane.id);
  });

  it("penalizes unexplained collinear overlap", () => {
    const first = routeSceneBetweenPorts({
      from: port("north-a:network", 380, 20, "bottom"),
      to: port("south-a:network", 380, 380, "top"),
    });
    const detour = { id: "lane:separate", axis: "vertical" as const, coordinate: 520, start: 0, end: 440, ownerId: "other", shared: false };
    const second = routeSceneBetweenPorts({
      from: port("north-b:network", 380, 20, "bottom"),
      to: port("south-b:network", 380, 380, "top"),
      lanes: [detour],
      ownerId: "other",
      priorRoutes: [first],
      overlapPenalty: 1_000,
    });

    // The two 14px port-egress segments are necessarily shared because both
    // test routes originate and terminate at the same connector centers. The
    // long center segment must move to the reserved lane.
    expect(countRouteOverlaps(second, [first])).toBe(2);
    expect(second.laneIds).toContain(detour.id);
  });
});

import type { FabricPort } from "@/lib/fabric/ports";

export interface FabricRoutePoint {
  x: number;
  y: number;
}

export interface FabricRoute {
  fromPortId: string;
  toPortId: string;
  points: FabricRoutePoint[];
  path: string;
}

const n = (value: number) => Number(value.toFixed(3));
const same = (a: FabricRoutePoint, b: FabricRoutePoint) => n(a.x) === n(b.x) && n(a.y) === n(b.y);

function compact(points: FabricRoutePoint[]): FabricRoutePoint[] {
  const result: FabricRoutePoint[] = [];
  for (const point of points) {
    const normalized = { x: n(point.x), y: n(point.y) };
    if (!result.length || !same(result[result.length - 1]!, normalized)) result.push(normalized);
  }
  return result;
}

function toPath(points: FabricRoutePoint[]): string {
  if (!points.length) return "";
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`)
    .join(" ");
}

/**
 * Deterministic orthogonal routing. Routes leave each connector in the
 * connector's declared direction, then meet on a stable lane. The first and
 * last points are always the exact materialized connector centers.
 */
export function routeBetweenPorts(from: FabricPort, to: FabricPort, laneBias = 0): FabricRoute {
  const a = from.center;
  const b = to.center;
  const horizontalA = from.side === "left" || from.side === "right";
  const horizontalB = to.side === "left" || to.side === "right";
  const escape = 14;

  const leaveA: FabricRoutePoint = horizontalA
    ? { x: a.x + (from.side === "right" ? escape : -escape), y: a.y }
    : { x: a.x, y: a.y + (from.side === "bottom" ? escape : -escape) };
  const enterB: FabricRoutePoint = horizontalB
    ? { x: b.x + (to.side === "right" ? escape : -escape), y: b.y }
    : { x: b.x, y: b.y + (to.side === "bottom" ? escape : -escape) };

  let middle: FabricRoutePoint[];
  if (horizontalA && horizontalB) {
    const laneX = n((leaveA.x + enterB.x) / 2 + laneBias);
    middle = [{ x: laneX, y: leaveA.y }, { x: laneX, y: enterB.y }];
  } else if (!horizontalA && !horizontalB) {
    const laneY = n((leaveA.y + enterB.y) / 2 + laneBias);
    middle = [{ x: leaveA.x, y: laneY }, { x: enterB.x, y: laneY }];
  } else if (horizontalA) {
    middle = [{ x: enterB.x + laneBias, y: leaveA.y }];
  } else {
    middle = [{ x: leaveA.x, y: enterB.y + laneBias }];
  }

  const points = compact([a, leaveA, ...middle, enterB, b]);
  return {
    fromPortId: from.id,
    toPortId: to.id,
    points,
    path: toPath(points),
  };
}

/** Exact-endpoint route through caller-selected shared-fabric lane points. */
export function routeViaPoints(
  from: FabricPort,
  to: FabricPort,
  via: FabricRoutePoint[],
): FabricRoute {
  const points = compact([from.center, ...via, to.center]);
  return {
    fromPortId: from.id,
    toPortId: to.id,
    points,
    path: toPath(points),
  };
}

export function routeHitsPorts(route: FabricRoute, from: FabricPort, to: FabricPort): boolean {
  const first = route.points[0];
  const last = route.points[route.points.length - 1];
  return Boolean(first && last && same(first, from.center) && same(last, to.center));
}

import type { FabricBounds } from "@/lib/fabric/layout";
import type { FabricPort } from "@/lib/fabric/ports";

export interface FabricRoutePoint {
  x: number;
  y: number;
}

export interface FabricObstacle {
  id: string;
  bounds: FabricBounds;
  padding?: number;
}

export interface FabricLane {
  id: string;
  axis: "horizontal" | "vertical";
  coordinate: number;
  start: number;
  end: number;
  ownerId?: string | null;
  shared?: boolean;
}

export interface FabricRouteSegment {
  from: FabricRoutePoint;
  to: FabricRoutePoint;
  axis: "horizontal" | "vertical";
  laneId?: string;
  shared: boolean;
}

export interface FabricRoute {
  fromPortId: string;
  toPortId: string;
  points: FabricRoutePoint[];
  path: string;
  segments?: FabricRouteSegment[];
  laneIds?: string[];
  junctions?: FabricRoutePoint[];
}

export interface FabricSceneRouteRequest {
  from: FabricPort;
  to: FabricPort;
  obstacles?: readonly FabricObstacle[];
  lanes?: readonly FabricLane[];
  priorRoutes?: readonly FabricRoute[];
  ownerId?: string;
  egress?: number;
  crossingPenalty?: number;
  overlapPenalty?: number;
  lanePenalty?: number;
  foreignLanePenalty?: number;
  allowSharedLaneIds?: readonly string[];
}

interface GraphNode {
  id: string;
  point: FabricRoutePoint;
}

interface GraphEdge {
  from: string;
  to: string;
  cost: number;
  laneId?: string;
  shared: boolean;
}

interface AxisSegment {
  from: FabricRoutePoint;
  to: FabricRoutePoint;
  axis: "horizontal" | "vertical";
}

const DEFAULT_EGRESS = 14;
const DEFAULT_CROSSING_PENALTY = 220;
const DEFAULT_OVERLAP_PENALTY = 320;
const DEFAULT_LANE_PENALTY = 18;
const DEFAULT_FOREIGN_LANE_PENALTY = 140;

const n = (value: number) => Number(value.toFixed(3));
const keyOf = (point: FabricRoutePoint) => `${n(point.x)}:${n(point.y)}`;
const min = (a: number, b: number) => (a < b ? a : b);
const max = (a: number, b: number) => (a > b ? a : b);

const samePoint = (a: FabricRoutePoint, b: FabricRoutePoint) => n(a.x) === n(b.x) && n(a.y) === n(b.y);

function normalizePoint(point: FabricRoutePoint): FabricRoutePoint {
  return { x: n(point.x), y: n(point.y) };
}

export function expandBounds(bounds: FabricBounds, padding: number): FabricBounds {
  return {
    x: n(bounds.x - padding),
    y: n(bounds.y - padding),
    width: n(bounds.width + padding * 2),
    height: n(bounds.height + padding * 2),
  };
}

export function pointInBounds(point: FabricRoutePoint, bounds: FabricBounds, inclusive = true): boolean {
  const left = inclusive ? point.x >= bounds.x : point.x > bounds.x;
  const right = inclusive ? point.x <= bounds.x + bounds.width : point.x < bounds.x + bounds.width;
  const top = inclusive ? point.y >= bounds.y : point.y > bounds.y;
  const bottom = inclusive ? point.y <= bounds.y + bounds.height : point.y < bounds.y + bounds.height;
  return left && right && top && bottom;
}

function axisOf(a: FabricRoutePoint, b: FabricRoutePoint): AxisSegment["axis"] {
  return n(a.x) === n(b.x) ? "vertical" : "horizontal";
}

function normalizeSegment(a: FabricRoutePoint, b: FabricRoutePoint): AxisSegment {
  const from = normalizePoint(a);
  const to = normalizePoint(b);
  if (samePoint(from, to)) {
    return { from, to, axis: "horizontal" };
  }
  if (axisOf(from, to) === "horizontal" && from.x > to.x) {
    return { from: to, to: from, axis: "horizontal" };
  }
  if (axisOf(from, to) === "vertical" && from.y > to.y) {
    return { from: to, to: from, axis: "vertical" };
  }
  return { from, to, axis: axisOf(from, to) };
}

function segmentLength(segment: AxisSegment): number {
  return segment.axis === "horizontal" ? Math.abs(segment.to.x - segment.from.x) : Math.abs(segment.to.y - segment.from.y);
}

function overlap1d(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const start = max(min(aStart, aEnd), min(bStart, bEnd));
  const end = min(max(aStart, aEnd), max(bStart, bEnd));
  return Math.max(0, n(end - start));
}

export function segmentsCross(a: AxisSegment, b: AxisSegment): boolean {
  if (a.axis === b.axis) return false;
  const horizontal = a.axis === "horizontal" ? a : b;
  const vertical = a.axis === "vertical" ? a : b;
  const crossesHorizontally = vertical.from.x > horizontal.from.x && vertical.from.x < horizontal.to.x;
  const crossesVertically = horizontal.from.y > vertical.from.y && horizontal.from.y < vertical.to.y;
  return crossesHorizontally && crossesVertically;
}

export function segmentsShareCollinearOverlap(a: AxisSegment, b: AxisSegment): boolean {
  if (a.axis !== b.axis) return false;
  if (a.axis === "horizontal") {
    if (n(a.from.y) !== n(b.from.y)) return false;
    return overlap1d(a.from.x, a.to.x, b.from.x, b.to.x) > 0;
  }
  if (n(a.from.x) !== n(b.from.x)) return false;
  return overlap1d(a.from.y, a.to.y, b.from.y, b.to.y) > 0;
}

export function segmentIntersectsBounds(segment: AxisSegment, bounds: FabricBounds): boolean {
  if (segment.axis === "horizontal") {
    const yInside = segment.from.y > bounds.y && segment.from.y < bounds.y + bounds.height;
    if (!yInside) return false;
    return overlap1d(segment.from.x, segment.to.x, bounds.x, bounds.x + bounds.width) > 0;
  }
  const xInside = segment.from.x > bounds.x && segment.from.x < bounds.x + bounds.width;
  if (!xInside) return false;
  return overlap1d(segment.from.y, segment.to.y, bounds.y, bounds.y + bounds.height) > 0;
}

function compact(points: FabricRoutePoint[]): FabricRoutePoint[] {
  const result: FabricRoutePoint[] = [];
  for (const point of points) {
    const normalized = normalizePoint(point);
    if (!result.length || !samePoint(result[result.length - 1]!, normalized)) {
      result.push(normalized);
    }
  }
  return result;
}

function simplify(points: FabricRoutePoint[]): FabricRoutePoint[] {
  const seeded = compact(points);
  if (seeded.length <= 2) return seeded;
  const result: FabricRoutePoint[] = [seeded[0]!];
  for (let index = 1; index < seeded.length - 1; index += 1) {
    const previous = result[result.length - 1]!;
    const current = seeded[index]!;
    const next = seeded[index + 1]!;
    const previousAxis = axisOf(previous, current);
    const nextAxis = axisOf(current, next);
    if (previousAxis === nextAxis) continue;
    result.push(current);
  }
  result.push(seeded[seeded.length - 1]!);
  return compact(result);
}

function toPath(points: FabricRoutePoint[]): string {
  if (!points.length) return "";
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join(" ");
}

export function routeSegments(route: Pick<FabricRoute, "points">): AxisSegment[] {
  const result: AxisSegment[] = [];
  for (let index = 0; index < route.points.length - 1; index += 1) {
    const from = route.points[index]!;
    const to = route.points[index + 1]!;
    if (samePoint(from, to)) continue;
    result.push(normalizeSegment(from, to));
  }
  return result;
}

export function routeIntersectsBounds(route: Pick<FabricRoute, "points">, bounds: FabricBounds): boolean {
  return routeSegments(route).some((segment) => segmentIntersectsBounds(segment, bounds));
}

export function countRouteCrossings(route: Pick<FabricRoute, "points">, others: Array<Pick<FabricRoute, "points">>): number {
  const own = routeSegments(route);
  const peerSegments = others.flatMap((other) => routeSegments(other));
  let count = 0;
  for (const segment of own) {
    for (const peer of peerSegments) {
      if (segmentsCross(segment, peer)) count += 1;
    }
  }
  return count;
}

export function countRouteOverlaps(route: Pick<FabricRoute, "points">, others: Array<Pick<FabricRoute, "points">>): number {
  const own = routeSegments(route);
  const peerSegments = others.flatMap((other) => routeSegments(other));
  let count = 0;
  for (const segment of own) {
    for (const peer of peerSegments) {
      if (segmentsShareCollinearOverlap(segment, peer)) count += 1;
    }
  }
  return count;
}

function leavePoint(port: FabricPort, escape: number): FabricRoutePoint {
  const { x, y } = port.center;
  if (port.side === "left") return { x: x - escape, y };
  if (port.side === "right") return { x: x + escape, y };
  if (port.side === "top") return { x, y: y - escape };
  return { x, y: y + escape };
}

function obstacleBounds(obstacles: readonly FabricObstacle[]): FabricBounds[] {
  return obstacles.map((obstacle) => expandBounds(obstacle.bounds, obstacle.padding ?? 0));
}

function laneCovers(lane: FabricLane, segment: AxisSegment): boolean {
  if (lane.axis !== segment.axis) return false;
  if (lane.axis === "horizontal") {
    if (n(lane.coordinate) !== n(segment.from.y)) return false;
    return overlap1d(segment.from.x, segment.to.x, lane.start, lane.end) >= segmentLength(segment);
  }
  if (n(lane.coordinate) !== n(segment.from.x)) return false;
  return overlap1d(segment.from.y, segment.to.y, lane.start, lane.end) >= segmentLength(segment);
}

function laneForSegment(segment: AxisSegment, lanes: readonly FabricLane[]): FabricLane | undefined {
  return lanes.find((lane) => laneCovers(lane, segment));
}

function segmentBlocked(segment: AxisSegment, blocked: readonly FabricBounds[]): boolean {
  if (segmentLength(segment) === 0) return false;
  return blocked.some((bounds) => segmentIntersectsBounds(segment, bounds));
}

function buildCoordinateSet(
  start: FabricRoutePoint,
  goal: FabricRoutePoint,
  blocked: readonly FabricBounds[],
  lanes: readonly FabricLane[],
): { xs: number[]; ys: number[] } {
  const xs = new Set<number>([n(start.x), n(goal.x)]);
  const ys = new Set<number>([n(start.y), n(goal.y)]);

  for (const bounds of blocked) {
    xs.add(n(bounds.x));
    xs.add(n(bounds.x + bounds.width));
    ys.add(n(bounds.y));
    ys.add(n(bounds.y + bounds.height));
  }

  for (const lane of lanes) {
    if (lane.axis === "horizontal") {
      ys.add(n(lane.coordinate));
      xs.add(n(lane.start));
      xs.add(n(lane.end));
    } else {
      xs.add(n(lane.coordinate));
      ys.add(n(lane.start));
      ys.add(n(lane.end));
    }
  }

  return {
    xs: [...xs].sort((a, b) => a - b),
    ys: [...ys].sort((a, b) => a - b),
  };
}

function buildNodes(xs: number[], ys: number[], blocked: readonly FabricBounds[]): Map<string, GraphNode> {
  const nodes = new Map<string, GraphNode>();
  for (const x of xs) {
    for (const y of ys) {
      const point = normalizePoint({ x, y });
      if (blocked.some((bounds) => pointInBounds(point, bounds, false))) continue;
      const id = keyOf(point);
      nodes.set(id, { id, point });
    }
  }
  return nodes;
}

function edgePenalty(
  segment: AxisSegment,
  lanes: readonly FabricLane[],
  prior: readonly AxisSegment[],
  request: FabricSceneRouteRequest,
): { cost: number; laneId?: string; shared: boolean } {
  const lane = laneForSegment(segment, lanes);
  const crossingPenalty = request.crossingPenalty ?? DEFAULT_CROSSING_PENALTY;
  const overlapPenalty = request.overlapPenalty ?? DEFAULT_OVERLAP_PENALTY;
  const lanePenalty = request.lanePenalty ?? DEFAULT_LANE_PENALTY;
  const foreignLanePenalty = request.foreignLanePenalty ?? DEFAULT_FOREIGN_LANE_PENALTY;
  const allowSharedLaneIds = new Set(request.allowSharedLaneIds ?? []);
  let cost = segmentLength(segment);
  if (!lane) {
    cost += lanePenalty;
  } else if (lane.ownerId && request.ownerId && lane.ownerId !== request.ownerId && !allowSharedLaneIds.has(lane.id)) {
    cost += foreignLanePenalty;
  }

  let shared = false;
  for (const peer of prior) {
    if (segmentsCross(segment, peer)) cost += crossingPenalty;
    if (segmentsShareCollinearOverlap(segment, peer)) {
      if (lane && (lane.shared || allowSharedLaneIds.has(lane.id))) {
        shared = true;
      } else {
        cost += overlapPenalty;
      }
    }
  }

  return { cost, laneId: lane?.id, shared };
}

function buildEdges(
  nodes: Map<string, GraphNode>,
  xs: number[],
  ys: number[],
  blocked: readonly FabricBounds[],
  lanes: readonly FabricLane[],
  prior: readonly AxisSegment[],
  request: FabricSceneRouteRequest,
): Map<string, GraphEdge[]> {
  const adjacency = new Map<string, GraphEdge[]>();
  const push = (edge: GraphEdge) => {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge);
    list.sort((a, b) => (a.cost - b.cost) || (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
    adjacency.set(edge.from, list);
  };

  for (const y of ys) {
    for (let index = 0; index < xs.length - 1; index += 1) {
      const from = nodes.get(keyOf({ x: xs[index]!, y }));
      const to = nodes.get(keyOf({ x: xs[index + 1]!, y }));
      if (!from || !to) continue;
      const segment = normalizeSegment(from.point, to.point);
      if (segmentBlocked(segment, blocked)) continue;
      const penalty = edgePenalty(segment, lanes, prior, request);
      push({ from: from.id, to: to.id, cost: penalty.cost, laneId: penalty.laneId, shared: penalty.shared });
      push({ from: to.id, to: from.id, cost: penalty.cost, laneId: penalty.laneId, shared: penalty.shared });
    }
  }

  for (const x of xs) {
    for (let index = 0; index < ys.length - 1; index += 1) {
      const from = nodes.get(keyOf({ x, y: ys[index]! }));
      const to = nodes.get(keyOf({ x, y: ys[index + 1]! }));
      if (!from || !to) continue;
      const segment = normalizeSegment(from.point, to.point);
      if (segmentBlocked(segment, blocked)) continue;
      const penalty = edgePenalty(segment, lanes, prior, request);
      push({ from: from.id, to: to.id, cost: penalty.cost, laneId: penalty.laneId, shared: penalty.shared });
      push({ from: to.id, to: from.id, cost: penalty.cost, laneId: penalty.laneId, shared: penalty.shared });
    }
  }

  return adjacency;
}

function heuristic(a: FabricRoutePoint, b: FabricRoutePoint): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function reconstructPath(
  goalId: string,
  startId: string,
  nodes: Map<string, GraphNode>,
  cameFrom: Map<string, string>,
): FabricRoutePoint[] {
  const points: FabricRoutePoint[] = [];
  let current: string | undefined = goalId;
  while (current) {
    points.push(nodes.get(current)!.point);
    if (current === startId) break;
    current = cameFrom.get(current);
  }
  return points.reverse();
}

function aStar(
  startId: string,
  goalId: string,
  nodes: Map<string, GraphNode>,
  adjacency: Map<string, GraphEdge[]>,
): { points: FabricRoutePoint[]; edges: GraphEdge[] } | null {
  const open = new Set<string>([startId]);
  const cameFrom = new Map<string, string>();
  const costSoFar = new Map<string, number>([[startId, 0]]);
  const via = new Map<string, GraphEdge>();

  while (open.size) {
    const current = [...open].sort((a, b) => {
      const aScore = (costSoFar.get(a) ?? Number.POSITIVE_INFINITY) + heuristic(nodes.get(a)!.point, nodes.get(goalId)!.point);
      const bScore = (costSoFar.get(b) ?? Number.POSITIVE_INFINITY) + heuristic(nodes.get(b)!.point, nodes.get(goalId)!.point);
      return (aScore - bScore) || (a < b ? -1 : 1);
    })[0]!;
    if (current === goalId) {
      const points = reconstructPath(goalId, startId, nodes, cameFrom);
      const edges: GraphEdge[] = [];
      for (let index = 1; index < points.length; index += 1) {
        const edge = via.get(keyOf(points[index]!));
        if (edge) edges.push(edge);
      }
      return { points, edges };
    }
    open.delete(current);
    for (const edge of adjacency.get(current) ?? []) {
      const next = edge.to;
      const nextCost = (costSoFar.get(current) ?? 0) + edge.cost;
      if (nextCost < (costSoFar.get(next) ?? Number.POSITIVE_INFINITY)) {
        costSoFar.set(next, nextCost);
        cameFrom.set(next, current);
        via.set(next, edge);
        open.add(next);
      }
    }
  }

  return null;
}

function metadataFromEdges(points: FabricRoutePoint[], edges: GraphEdge[]): Pick<FabricRoute, "segments" | "laneIds" | "junctions"> {
  const laneIds = new Set<string>();
  const segments: FabricRouteSegment[] = [];
  const junctions: FabricRoutePoint[] = [];

  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index]!;
    const from = points[index]!;
    const to = points[index + 1]!;
    const segment = normalizeSegment(from, to);
    if (edge.laneId) laneIds.add(edge.laneId);
    segments.push({
      from: segment.from,
      to: segment.to,
      axis: segment.axis,
      laneId: edge.laneId,
      shared: edge.shared,
    });
    if (index > 0) {
      const previous = segments[index - 1]!;
      if (previous.axis !== segment.axis) junctions.push(from);
    }
  }

  return {
    segments,
    laneIds: [...laneIds],
    junctions,
  };
}

export function routeSceneBetweenPorts(request: FabricSceneRouteRequest): FabricRoute {
  const blocked = obstacleBounds(request.obstacles ?? []);
  const start = leavePoint(request.from, request.egress ?? DEFAULT_EGRESS);
  const goal = leavePoint(request.to, request.egress ?? DEFAULT_EGRESS);
  const lanes = request.lanes ?? [];
  const prior = (request.priorRoutes ?? []).flatMap((route) => routeSegments(route));
  const { xs, ys } = buildCoordinateSet(start, goal, blocked, lanes);
  const nodes = buildNodes(xs, ys, blocked);
  const startId = keyOf(start);
  const goalId = keyOf(goal);
  nodes.set(startId, { id: startId, point: normalizePoint(start) });
  nodes.set(goalId, { id: goalId, point: normalizePoint(goal) });
  const adjacency = buildEdges(nodes, [...new Set([...xs, start.x, goal.x])].sort((a, b) => a - b), [...new Set([...ys, start.y, goal.y])].sort((a, b) => a - b), blocked, lanes, prior, request);
  const solution = aStar(startId, goalId, nodes, adjacency);
  if (!solution) {
    throw new Error(`No obstacle-free orthogonal route between ${request.from.id} and ${request.to.id}`);
  }
  const through = solution.points;
  const points = simplify([request.from.center, ...through, request.to.center]);
  const metadata = metadataFromEdges(through, solution.edges);
  return {
    fromPortId: request.from.id,
    toPortId: request.to.id,
    points,
    path: toPath(points),
    ...metadata,
  };
}

/**
 * Deterministic orthogonal routing with exact visible endpoints. The scene
 * router is obstacle-aware when the caller opts in; the compatibility surface
 * remains a stable no-obstacle route.
 */
export function routeBetweenPorts(from: FabricPort, to: FabricPort, laneBias = 0): FabricRoute {
  const horizontalA = from.side === "left" || from.side === "right";
  const horizontalB = to.side === "left" || to.side === "right";

  if (laneBias === 0) {
    return routeSceneBetweenPorts({ from, to });
  }

  if (horizontalA && horizontalB) {
    const laneX = n(((leavePoint(from, DEFAULT_EGRESS).x + leavePoint(to, DEFAULT_EGRESS).x) / 2) + laneBias);
    return routeSceneBetweenPorts({
      from,
      to,
      lanes: [{ id: `compat:v:${laneX}`, axis: "vertical", coordinate: laneX, start: 0, end: 2000 }],
    });
  }
  if (!horizontalA && !horizontalB) {
    const laneY = n(((leavePoint(from, DEFAULT_EGRESS).y + leavePoint(to, DEFAULT_EGRESS).y) / 2) + laneBias);
    return routeSceneBetweenPorts({
      from,
      to,
      lanes: [{ id: `compat:h:${laneY}`, axis: "horizontal", coordinate: laneY, start: 0, end: 2000 }],
    });
  }
  return routeSceneBetweenPorts({ from, to });
}

/** Exact-endpoint route through caller-selected shared-fabric lane points. */
export function routeViaPoints(
  from: FabricPort,
  to: FabricPort,
  via: FabricRoutePoint[],
): FabricRoute {
  const points = simplify([from.center, ...via, to.center]);
  return {
    fromPortId: from.id,
    toPortId: to.id,
    points,
    path: toPath(points),
    segments: routeSegments({ points }).map((segment) => ({
      from: segment.from,
      to: segment.to,
      axis: segment.axis,
      shared: false,
    })),
    laneIds: [],
    junctions: points.slice(1, -1),
  };
}

export function routeHitsPorts(route: FabricRoute, from: FabricPort, to: FabricPort): boolean {
  const first = route.points[0];
  const last = route.points[route.points.length - 1];
  return Boolean(first && last && samePoint(first, from.center) && samePoint(last, to.center));
}

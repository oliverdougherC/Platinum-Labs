import type { FabricBounds } from "@/lib/fabric/layout";
import type {
  FabricModel,
  FabricNode,
  FabricNodeStatus,
  FabricPlane,
  FabricRelationship,
} from "@/lib/fabric/model";
import type { FabricPortKind } from "@/lib/fabric/ports";

export type FabricCompositionId = "A" | "B" | "C";
export type FabricSegmentPlane = "network" | "control" | "read" | "write";

export interface CompositionPoint {
  x: number;
  y: number;
}

export interface FabricCompositionNode {
  id: string;
  sourceNodeId: string;
  kind: FabricNode["kind"];
  role: "resource" | "boundary" | "gateway" | "orchestration" | "data-plane" | "subsystem" | "storage";
  label: string;
  eyebrow: string;
  status: FabricNodeStatus;
  bounds: FabricBounds;
  metrics: FabricNode["metrics"];
  portKinds: FabricPortKind[];
  memberIds: string[];
  promoted: string[];
}

export interface FabricPhysicalSegment {
  id: string;
  plane: FabricSegmentPlane;
  points: CompositionPoint[];
  label: string;
  labelBounds: FabricBounds;
  endpointIds: [string, string];
  logicalContributorIds: string[];
  directions: Array<"forward" | "reverse">;
}

export interface FabricLogicalRoute {
  relationshipId: string;
  label: string;
  plane: FabricRelationship["plane"];
  segmentIds: string[];
  fromPortId: string;
  toPortId: string;
  direction: FabricRelationship["direction"];
  evidence: FabricRelationship["evidence"];
}

export interface FabricCompositionScene {
  id: FabricCompositionId;
  title: string;
  thesis: string;
  viewBox: { width: 1200; height: 680 };
  nodes: FabricCompositionNode[];
  segments: FabricPhysicalSegment[];
  logicalRoutes: FabricLogicalRoute[];
  representedIds: string[];
  summaryIds: string[];
  occupiedBounds: FabricBounds;
}

export interface FabricCompositionValidation {
  duplicateGeometry: string[];
  segmentLabelIntersections: string[];
  segmentNodeIntersections: string[];
  textOverflow: string[];
  unapprovedCrossings: string[];
  longNetworkLabels: string[];
  danglingSegments: string[];
  missingPopulationIds: string[];
  occupiedAreaRatio: number;
  horizontallyBalanced: boolean;
  valid: boolean;
}

const VIEWBOX = { width: 1200, height: 680 } as const;
const rect = (x: number, y: number, width: number, height: number): FabricBounds => ({ x, y, width, height });
const point = (x: number, y: number): CompositionPoint => ({ x, y });

function nodeMap(model: FabricModel): Map<string, FabricNode> {
  return new Map(model.nodes.map((node) => [node.id, node]));
}

function sourceNode(model: FabricModel, id: string): FabricNode {
  const node = nodeMap(model).get(id);
  if (!node) throw new Error(`composition source node missing: ${id}`);
  return node;
}

function compactLabel(value: string, limit = 24): string {
  const normalized = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function compactMetricValue(value: string): string {
  return value.replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ").replace(/\bTB\b/g, "T").replace(/\bGB\b/g, "G").replace(/\bMB\b/g, "M");
}

function promotedMembers(model: FabricModel, nodeId: string): string[] {
  const group = model.population.groups.find((item) => item.id === nodeId);
  if (!group) return [];
  const promoted = group.members.filter((member) =>
    member.attention ||
    (member.cpuFraction ?? 0) >= 0.25 ||
    (member.netRxBps ?? 0) >= 1_000_000 ||
    (member.netTxBps ?? 0) >= 1_000_000 ||
    (member.blockReadBps ?? 0) >= 1_000_000 ||
    (member.blockWriteBps ?? 0) >= 1_000_000,
  );
  return (promoted.length ? promoted : group.members.slice(0, 1)).slice(0, 2).map((member) => compactLabel(member.name, 18));
}

function compositionNode(
  model: FabricModel,
  id: string,
  bounds: FabricBounds,
  role: FabricCompositionNode["role"],
): FabricCompositionNode {
  const source = sourceNode(model, id);
  const accounted = model.population.accountedNodes.find((item) => item.nodeId === id);
  const textLimit = Math.max(6, Math.floor((bounds.width - 24) / 8.2));
  const eyebrowLimit = Math.max(6, Math.floor((bounds.width - 20) / 6.2));
  const metrics = role === "storage" && source.metrics.length >= 2
    ? [{ label: "CAP · USED", value: `${compactMetricValue(source.metrics[0]!.value)} · ${source.metrics[1]!.value}` }]
    : source.metrics.slice(0, role === "subsystem" ? 3 : 2).map((metric) => ({ ...metric, value: compactMetricValue(metric.value) }));
  return {
    id: `study:${id}`,
    sourceNodeId: id,
    kind: source.kind,
    role,
    label: compactLabel(source.label, Math.min(textLimit, role === "subsystem" ? 20 : 26)),
    eyebrow: compactLabel(source.eyebrow, Math.min(eyebrowLimit, 34)).toUpperCase(),
    status: source.status,
    bounds,
    metrics,
    portKinds: [...new Set(model.ports.filter((port) => port.nodeId === id).map((port) => port.kind))],
    memberIds: accounted?.containerIds ?? [],
    promoted: promotedMembers(model, id),
  };
}

function coreContributorIds(model: FabricModel, plane: FabricSegmentPlane): string[] {
  return model.relationships.filter((relationship) => {
    if (plane === "control") return relationship.plane === "control";
    if (plane === "network") return relationship.fromPortId.includes("network") || relationship.toPortId.includes("network");
    return relationship.fromPortId.includes(`:${plane}`) || relationship.toPortId.includes(`:${plane}`);
  }).map((relationship) => relationship.id);
}

function directionsFor(model: FabricModel, contributorIds: string[]): Array<"forward" | "reverse"> {
  const result = new Set<"forward" | "reverse">();
  for (const relationship of model.relationships) {
    if (!contributorIds.includes(relationship.id)) continue;
    if (relationship.direction !== "reverse") result.add("forward");
    if (relationship.direction !== "forward") result.add("reverse");
  }
  return [...result];
}

function segment(
  model: FabricModel,
  id: string,
  plane: FabricSegmentPlane,
  points: CompositionPoint[],
  label: string,
  labelBounds: FabricBounds,
  endpointIds: [string, string],
): FabricPhysicalSegment {
  const logicalContributorIds = coreContributorIds(model, plane);
  return {
    id,
    plane,
    points,
    label,
    labelBounds,
    endpointIds,
    logicalContributorIds,
    directions: directionsFor(model, logicalContributorIds),
  };
}

function resourceNodes(model: FabricModel): FabricCompositionNode[] {
  const positions = [rect(24, 30, 342, 88), rect(378, 30, 242, 88), rect(632, 30, 326, 88), rect(970, 30, 206, 88)];
  return ["resource:cpu", "resource:memory", "resource:gpu", "resource:arc"].map((id, index) =>
    compositionNode(model, id, positions[index]!, "resource"),
  );
}

function groupIds(model: FabricModel): string[] {
  return model.nodes.filter((node) => node.kind === "group").map((node) => node.id);
}

function poolIds(model: FabricModel): string[] {
  return model.nodes.filter((node) => node.kind === "storage").map((node) => node.id).slice(0, 3);
}

function layeredBus(model: FabricModel): Pick<FabricCompositionScene, "title" | "thesis" | "nodes" | "segments"> {
  const groups = groupIds(model);
  const pools = poolIds(model);
  const nodes = [
    ...resourceNodes(model),
    compositionNode(model, "external:wan", rect(24, 137, 86, 38), "boundary"),
    compositionNode(model, "fabric:gateway", rect(126, 132, 126, 48), "gateway"),
    compositionNode(model, "service:seerr", rect(214, 192, 222, 72), "orchestration"),
    compositionNode(model, "service:sonarr", rect(489, 192, 222, 72), "orchestration"),
    compositionNode(model, "service:radarr", rect(764, 192, 222, 72), "orchestration"),
    compositionNode(model, "service:qbittorrent", rect(272, 328, 278, 82), "data-plane"),
    compositionNode(model, "service:jellyfin", rect(650, 328, 278, 82), "data-plane"),
    ...groups.map((id, index) => compositionNode(model, id, rect(42 + index * 290, 440, 246, 72), "subsystem")),
    ...pools.map((id, index) => compositionNode(model, id, rect(150 + index * 315, 594, 270, 62), "storage")),
  ];
  const segments = [
    segment(model, "segment:wan-gateway", "network", [point(110, 156), point(126, 156)], "WAN DUPLEX", rect(28, 119, 96, 14), ["external:wan", "fabric:gateway"]),
    segment(model, "segment:network", "network", [point(252, 156), point(1148, 156)], "SHARED DOCKER NETWORK SUBSTRATE", rect(790, 132, 348, 16), ["fabric:gateway", "boundary:network-east"]),
    segment(model, "segment:control", "control", [point(174, 294), point(1026, 294)], "CONTROL SUBSTRATE", rect(180, 272, 172, 16), ["boundary:control-west", "boundary:control-east"]),
    segment(model, "segment:read", "read", [point(148, 542), point(1052, 542)], "READ SUBSTRATE", rect(150, 520, 142, 16), ["boundary:read-west", "boundary:read-east"]),
    segment(model, "segment:write", "write", [point(148, 570), point(1052, 570)], "WRITE SUBSTRATE", rect(906, 548, 146, 16), ["boundary:write-west", "boundary:write-east"]),
  ];
  return { title: "A · Layered bus", thesis: "Accounting above; network, control, workloads, subsystem summaries, and storage read top-to-bottom.", nodes, segments };
}

function operationalPipeline(model: FabricModel): Pick<FabricCompositionScene, "title" | "thesis" | "nodes" | "segments"> {
  const groups = groupIds(model);
  const pools = poolIds(model);
  const displayedPools = pools.length >= 3 ? [pools[1]!, pools[0]!, pools[2]!] : pools;
  const nodes = [
    ...resourceNodes(model),
    compositionNode(model, "external:wan", rect(24, 254, 82, 44), "boundary"),
    compositionNode(model, "fabric:gateway", rect(122, 248, 112, 56), "gateway"),
    compositionNode(model, "service:seerr", rect(264, 154, 170, 60), "orchestration"),
    compositionNode(model, "service:sonarr", rect(264, 225, 170, 60), "orchestration"),
    compositionNode(model, "service:radarr", rect(264, 296, 170, 60), "orchestration"),
    compositionNode(model, "service:qbittorrent", rect(488, 242, 206, 72), "data-plane"),
    ...displayedPools.map((id, index) => compositionNode(model, id, rect(748, 164 + index * 82, 190, 66), "storage")),
    compositionNode(model, "service:jellyfin", rect(986, 242, 190, 72), "data-plane"),
    ...groups.map((id, index) => compositionNode(model, id, rect(42 + index * 290, 474, 246, 76), "subsystem")),
  ];
  const segments = [
    segment(model, "segment:wan-gateway", "network", [point(106, 276), point(122, 276)], "WAN", rect(24, 232, 56, 14), ["external:wan", "fabric:gateway"]),
    segment(model, "segment:network", "network", [point(234, 276), point(246, 276), point(246, 392), point(470, 392), point(470, 276), point(488, 276)], "ACQUISITION NETWORK", rect(288, 404, 186, 16), ["fabric:gateway", "service:qbittorrent"]),
    segment(model, "segment:control", "control", [point(446, 220), point(590, 220), point(590, 242)], "REQUEST + ORCHESTRATION", rect(448, 194, 210, 16), ["stage:orchestration", "service:qbittorrent"]),
    segment(model, "segment:write", "write", [point(694, 276), point(748, 276)], "WRITE", rect(696, 252, 48, 16), ["service:qbittorrent", pools[0] ?? "storage"]),
    segment(model, "segment:read", "read", [point(938, 276), point(986, 276)], "READ", rect(940, 252, 44, 16), [pools[0] ?? "storage", "service:jellyfin"]),
  ];
  return { title: "B · Operational pipeline", thesis: "External request, acquisition, storage, and playback read left-to-right; support stays subordinate.", nodes, segments };
}

function compactMotherboard(model: FabricModel): Pick<FabricCompositionScene, "title" | "thesis" | "nodes" | "segments"> {
  const groups = groupIds(model);
  const pools = poolIds(model);
  const nodes = [
    ...resourceNodes(model),
    compositionNode(model, "external:wan", rect(24, 268, 82, 42), "boundary"),
    compositionNode(model, "fabric:gateway", rect(122, 260, 116, 58), "gateway"),
    compositionNode(model, "service:seerr", rect(314, 140, 168, 62), "orchestration"),
    compositionNode(model, "service:sonarr", rect(516, 140, 168, 62), "orchestration"),
    compositionNode(model, "service:radarr", rect(718, 140, 168, 62), "orchestration"),
    compositionNode(model, "service:qbittorrent", rect(154, 358, 226, 76), "data-plane"),
    compositionNode(model, "service:jellyfin", rect(820, 358, 226, 76), "data-plane"),
    ...groups.slice(0, 2).map((id, index) => compositionNode(model, id, rect(44 + index * 258, 480, 226, 76), "subsystem")),
    ...groups.slice(2).map((id, index) => compositionNode(model, id, rect(930 - index * 258, 480, 226, 76), "subsystem")),
    ...pools.map((id, index) => compositionNode(model, id, rect(260 + index * 250, 590, 218, 62), "storage")),
  ];
  const segments = [
    segment(model, "segment:wan-gateway", "network", [point(106, 289), point(122, 289)], "WAN", rect(26, 246, 54, 14), ["external:wan", "fabric:gateway"]),
    segment(model, "segment:network", "network", [point(238, 289), point(962, 289)], "NETWORK", rect(550, 262, 100, 16), ["fabric:gateway", "boundary:network-east"]),
    segment(model, "segment:control", "control", [point(388, 328), point(812, 328)], "CONTROL", rect(552, 306, 96, 16), ["boundary:control-west", "boundary:control-east"]),
    segment(model, "segment:read", "read", [point(416, 382), point(784, 382)], "READ", rect(426, 360, 64, 16), ["boundary:read-west", "boundary:read-east"]),
    segment(model, "segment:write", "write", [point(416, 416), point(784, 416)], "WRITE", rect(710, 394, 70, 16), ["boundary:write-west", "boundary:write-east"]),
  ];
  return { title: "C · Compact motherboard", thesis: "A compact central substrate stack with workloads and subsystem modules arranged by real attachment.", nodes, segments };
}

function segmentIdsForRelationship(relationship: FabricRelationship, segments: FabricPhysicalSegment[]): string[] {
  const available = new Set(segments.map((item) => item.id));
  if (relationship.plane === "control") return available.has("segment:control") ? ["segment:control"] : [];
  const portIds = `${relationship.fromPortId} ${relationship.toPortId}`;
  if (portIds.includes("network")) return ["segment:wan-gateway", "segment:network"].filter((id) => available.has(id));
  const ordered = relationship.direction === "reverse" ? ["segment:read", "segment:write"] : ["segment:write", "segment:read"];
  const matched = ordered.filter((id) => portIds.includes(id.slice("segment:".length)) && available.has(id));
  return matched.length ? matched : ordered.filter((id) => available.has(id));
}

function logicalRoutes(model: FabricModel, segments: FabricPhysicalSegment[]): FabricLogicalRoute[] {
  return model.relationships.map((relationship) => ({
    relationshipId: relationship.id,
    label: relationship.label,
    plane: relationship.plane,
    segmentIds: segmentIdsForRelationship(relationship, segments),
    fromPortId: relationship.fromPortId,
    toPortId: relationship.toPortId,
    direction: relationship.direction,
    evidence: relationship.evidence,
  }));
}

function occupiedBounds(nodes: FabricCompositionNode[]): FabricBounds {
  const minX = Math.min(...nodes.map((node) => node.bounds.x));
  const minY = Math.min(...nodes.map((node) => node.bounds.y));
  const maxX = Math.max(...nodes.map((node) => node.bounds.x + node.bounds.width));
  const maxY = Math.max(...nodes.map((node) => node.bounds.y + node.bounds.height));
  return rect(minX, minY, maxX - minX, maxY - minY);
}

export function buildFabricComposition(model: FabricModel, id: FabricCompositionId): FabricCompositionScene {
  const base = id === "A" ? layeredBus(model) : id === "B" ? operationalPipeline(model) : compactMotherboard(model);
  const summaryIds = [...new Set(model.population.accountedNodes.flatMap((node) => node.containerIds))].sort();
  return {
    id,
    ...base,
    viewBox: VIEWBOX,
    logicalRoutes: logicalRoutes(model, base.segments),
    representedIds: [...model.population.ids].sort(),
    summaryIds,
    occupiedBounds: occupiedBounds(base.nodes),
  };
}

function geometryKey(segment: FabricPhysicalSegment): string {
  const forward = segment.points.map((p) => `${p.x},${p.y}`).join(";");
  const reverse = [...segment.points].reverse().map((p) => `${p.x},${p.y}`).join(";");
  return forward < reverse ? forward : reverse;
}

function lineSegments(points: CompositionPoint[]): Array<[CompositionPoint, CompositionPoint]> {
  return points.slice(1).map((to, index) => [points[index]!, to]);
}

function pointInside(bounds: FabricBounds, p: CompositionPoint): boolean {
  return p.x > bounds.x && p.x < bounds.x + bounds.width && p.y > bounds.y && p.y < bounds.y + bounds.height;
}

function lineIntersectsRect(a: CompositionPoint, b: CompositionPoint, bounds: FabricBounds): boolean {
  if (pointInside(bounds, a) || pointInside(bounds, b)) return true;
  if (a.x === b.x) return a.x > bounds.x && a.x < bounds.x + bounds.width && Math.max(a.y, b.y) > bounds.y && Math.min(a.y, b.y) < bounds.y + bounds.height;
  if (a.y === b.y) return a.y > bounds.y && a.y < bounds.y + bounds.height && Math.max(a.x, b.x) > bounds.x && Math.min(a.x, b.x) < bounds.x + bounds.width;
  return false;
}

function strictCrossing(a1: CompositionPoint, a2: CompositionPoint, b1: CompositionPoint, b2: CompositionPoint): boolean {
  const aHorizontal = a1.y === a2.y;
  const bHorizontal = b1.y === b2.y;
  if (aHorizontal === bHorizontal) return false;
  const h1 = aHorizontal ? a1 : b1;
  const h2 = aHorizontal ? a2 : b2;
  const v1 = aHorizontal ? b1 : a1;
  const v2 = aHorizontal ? b2 : a2;
  const x = v1.x;
  const y = h1.y;
  return x > Math.min(h1.x, h2.x) && x < Math.max(h1.x, h2.x) && y > Math.min(v1.y, v2.y) && y < Math.max(v1.y, v2.y);
}

export function validateFabricComposition(scene: FabricCompositionScene): FabricCompositionValidation {
  const keys = new Map<string, string>();
  const duplicateGeometry: string[] = [];
  for (const segment of scene.segments) {
    const key = geometryKey(segment);
    const existing = keys.get(key);
    if (existing) duplicateGeometry.push(`${existing}:${segment.id}`);
    keys.set(key, segment.id);
  }
  const segmentLabelIntersections: string[] = [];
  const segmentNodeIntersections: string[] = [];
  for (const segment of scene.segments) {
    for (const [a, b] of lineSegments(segment.points)) {
      if (lineIntersectsRect(a, b, segment.labelBounds)) segmentLabelIntersections.push(segment.id);
      for (const node of scene.nodes) {
        if (segment.endpointIds.includes(node.sourceNodeId)) continue;
        if (lineIntersectsRect(a, b, node.bounds)) segmentNodeIntersections.push(`${segment.id}:${node.sourceNodeId}`);
      }
    }
  }
  const textOverflow = scene.nodes.flatMap((node) => {
    const usable = node.bounds.width - 20;
    const candidates = [node.label, ...(node.bounds.height >= 55 ? [node.eyebrow] : []), ...node.metrics.flatMap((metric) => [metric.label, metric.value]), ...node.promoted];
    return candidates.filter((text) => text.length * 6 > usable).map((text) => `${node.sourceNodeId}:${text}`);
  });
  const unapprovedCrossings: string[] = [];
  for (let i = 0; i < scene.segments.length; i++) {
    for (let j = i + 1; j < scene.segments.length; j++) {
      const left = scene.segments[i]!;
      const right = scene.segments[j]!;
      for (const [a1, a2] of lineSegments(left.points)) {
        for (const [b1, b2] of lineSegments(right.points)) {
          if (strictCrossing(a1, a2, b1, b2)) unapprovedCrossings.push(`${left.id}:${right.id}`);
        }
      }
    }
  }
  const longNetworkLabels = scene.segments.filter((item) => item.plane === "network" && item.label.length > 36).map((item) => item.id);
  const danglingSegments = scene.segments.filter((item) => item.endpointIds.some((id) => !id || id.startsWith("empty:"))).map((item) => item.id);
  const summary = new Set(scene.summaryIds);
  const missingPopulationIds = scene.representedIds.filter((id) => !summary.has(id));
  const occupiedAreaRatio = (scene.occupiedBounds.width * scene.occupiedBounds.height) / (scene.viewBox.width * scene.viewBox.height);
  const center = scene.occupiedBounds.x + scene.occupiedBounds.width / 2;
  const horizontallyBalanced = Math.abs(center - scene.viewBox.width / 2) <= scene.viewBox.width * 0.08;
  const valid = [duplicateGeometry, segmentLabelIntersections, segmentNodeIntersections, textOverflow, unapprovedCrossings, longNetworkLabels, danglingSegments, missingPopulationIds].every((items) => items.length === 0) && occupiedAreaRatio >= 0.72 && horizontallyBalanced;
  return { duplicateGeometry, segmentLabelIntersections, segmentNodeIntersections, textOverflow, unapprovedCrossings, longNetworkLabels, danglingSegments, missingPopulationIds, occupiedAreaRatio, horizontallyBalanced, valid };
}

export function relationshipPlaneToSegmentPlane(plane: FabricPlane, ports: string): FabricSegmentPlane | null {
  if (plane === "control") return "control";
  if (plane !== "data") return null;
  if (ports.includes("write")) return "write";
  if (ports.includes("read")) return "read";
  return "network";
}

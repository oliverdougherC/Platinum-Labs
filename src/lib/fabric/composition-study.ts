import type { FabricBounds } from "@/lib/fabric/layout";
import type {
  FabricModel,
  FabricNode,
  FabricNodeStatus,
  FabricPlane,
  FabricRelationship,
  FabricResourceView,
} from "@/lib/fabric/model";
import type { FabricPort, FabricPortKind } from "@/lib/fabric/ports";

export type FabricCompositionId = "A" | "A+" | "B" | "C";
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
  ports: FabricCompositionPort[];
  memberIds: string[];
  promoted: string[];
  resourceView: FabricResourceView | null;
}

export interface FabricCompositionPort {
  id: string;
  kind: FabricPortKind;
  center: CompositionPoint;
}

export interface FabricCompositionJunction {
  id: string;
  plane: FabricSegmentPlane;
  kind: "junction" | "via";
  point: CompositionPoint;
}

export interface FabricPhysicalSegment {
  id: string;
  plane: FabricSegmentPlane;
  points: CompositionPoint[];
  label: string;
  labelBounds: FabricBounds;
  endpointIds: [string, string];
  junctionIds: string[];
  logicalContributorIds: string[];
  directions: Array<"forward" | "reverse">;
}

export interface FabricLogicalRoute {
  relationshipId: string;
  label: string;
  plane: FabricRelationship["plane"];
  segmentIds: string[];
  fromNodeId: string;
  toNodeId: string;
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
  junctions: FabricCompositionJunction[];
  segments: FabricPhysicalSegment[];
  logicalRoutes: FabricLogicalRoute[];
  representedIds: string[];
  summaryIds: string[];
  occupiedBounds: FabricBounds;
  density: FabricCompositionDensity;
  primaryStorageCorridors: Array<{ nodeId: string; bounds: FabricBounds }>;
}

export interface FabricCompositionDensity {
  columns: number[];
  rows: number[];
  occupiedCellRatio: number;
  largestInternalVoid: number;
}

export interface FabricCompositionValidation {
  duplicateGeometry: string[];
  segmentLabelIntersections: string[];
  segmentNodeIntersections: string[];
  textOverflow: string[];
  unapprovedCrossings: string[];
  longNetworkLabels: string[];
  danglingSegments: string[];
  unattachedPortIds: string[];
  trunkOnlyRouteIds: string[];
  blockedStorageCorridors: string[];
  missingPopulationIds: string[];
  density: FabricCompositionDensity;
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

function defaultCompositionPorts(model: FabricModel, nodeId: string, bounds: FabricBounds): FabricCompositionPort[] {
  const ports = model.ports.filter((port) => port.nodeId === nodeId);
  return ports.map((port, index) => ({
    id: port.id,
    kind: port.kind,
    center: point(bounds.x + bounds.width - 12 - index * 13, bounds.y + bounds.height),
  }));
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
    ports: defaultCompositionPorts(model, id, bounds),
    memberIds: accounted?.containerIds ?? [],
    promoted: promotedMembers(model, id),
    resourceView: model.resourceViews.find((view) => view.nodeId === id) ?? null,
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
  junctionIds: string[] = [],
): FabricPhysicalSegment {
  const logicalContributorIds = coreContributorIds(model, plane);
  return {
    id,
    plane,
    points,
    label,
    labelBounds,
    endpointIds,
    junctionIds,
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

function aPlusPorts(model: FabricModel, node: FabricCompositionNode, indexByRole: number): FabricCompositionPort[] {
  const sourcePorts = model.ports.filter((port) => port.nodeId === node.sourceNodeId);
  const { bounds } = node;
  const at = (port: FabricPort, x: number, y: number): FabricCompositionPort => ({ id: port.id, kind: port.kind, center: point(x, y) });

  if (node.sourceNodeId === "fabric:gateway") {
    return sourcePorts.map((port) => port.id.includes("external-network")
      ? at(port, bounds.x, bounds.y + 25)
      : at(port, bounds.x + bounds.width, bounds.y + bounds.height - 24));
  }
  if (node.sourceNodeId.startsWith("network:")) {
    return sourcePorts.map((port) => at(port, bounds.x + bounds.width, bounds.y + bounds.height / 2));
  }
  if (node.sourceNodeId === "external:wan") {
    return sourcePorts.map((port) => at(port, bounds.x + bounds.width, bounds.y + bounds.height / 2));
  }
  if (node.role === "orchestration") {
    const storageX = node.sourceNodeId === "service:sonarr"
      ? { read: 616, write: 636 }
      : node.sourceNodeId === "service:radarr"
        ? { read: 966, write: 978 }
        : { read: bounds.x + 72, write: bounds.x + 92 };
    return sourcePorts.map((port) => {
      if (port.kind === "network") return at(port, bounds.x + bounds.width / 2, bounds.y);
      if (port.kind === "control") return at(port, bounds.x + bounds.width - 54, bounds.y + bounds.height);
      return at(port, storageX[port.kind], bounds.y + bounds.height);
    });
  }
  if (node.role === "data-plane") {
    const qbit = node.sourceNodeId === "service:qbittorrent";
    return sourcePorts.map((port) => {
      if (port.kind === "network") return at(port, qbit ? bounds.x : bounds.x + bounds.width, bounds.y + 28);
      if (port.kind === "control") return at(port, bounds.x + (qbit ? 66 : bounds.width - 66), bounds.y);
      if (port.kind === "read") return at(port, bounds.x + (qbit ? 116 : 110), bounds.y + bounds.height);
      return at(port, bounds.x + (qbit ? 216 : 210), bounds.y + bounds.height);
    });
  }
  if (node.role === "subsystem") {
    const leftShelf = indexByRole < 2;
    return sourcePorts.map((port) => at(
      port,
      leftShelf ? bounds.x + bounds.width : bounds.x,
      leftShelf ? bounds.y : bounds.y + 18,
    ));
  }
  if (node.role === "storage") {
    return sourcePorts.map((port) => at(
      port,
      bounds.x + bounds.width * (port.kind === "read" ? 0.34 : port.kind === "write" ? 0.7 : 0.52),
      bounds.y,
    ));
  }
  return node.ports;
}

function portFor(node: FabricCompositionNode, kind: FabricPortKind): FabricCompositionPort | null {
  return node.ports.find((port) => port.kind === kind) ?? null;
}

function aPlusSynthesis(model: FabricModel): Pick<FabricCompositionScene, "title" | "thesis" | "nodes" | "junctions" | "segments" | "primaryStorageCorridors"> {
  const groups = groupIds(model).slice(0, 4);
  const pools = poolIds(model);
  const visibleNetworkIds = model.nodes.filter((node) => node.id.startsWith("network:")).slice(0, 3).map((node) => node.id);
  const rawNodes = [
    ...[
      ["resource:cpu", rect(24, 26, 318, 88)],
      ["resource:memory", rect(354, 26, 246, 88)],
      ["resource:gpu", rect(612, 26, 302, 88)],
      ["resource:arc", rect(926, 26, 250, 88)],
    ].map(([id, bounds]) => compositionNode(model, id as string, bounds as FabricBounds, "resource")),
    compositionNode(model, "external:wan", rect(24, 142, 100, 34), "boundary"),
    compositionNode(model, "external:lan", rect(24, 184, 100, 34), "boundary"),
    compositionNode(model, "external:overlay", rect(24, 226, 100, 34), "boundary"),
    { ...compositionNode(model, "fabric:gateway", rect(132, 142, 132, 118), "gateway"), eyebrow: "HOST NETWORK" },
    ...visibleNetworkIds.map((id, index) => compositionNode(model, id, rect(24, 276 + index * 40, 240, 34), "gateway")),
    compositionNode(model, "service:seerr", rect(276, 150, 278, 72), "orchestration"),
    compositionNode(model, "service:sonarr", rect(580, 150, 278, 72), "orchestration"),
    compositionNode(model, "service:radarr", rect(884, 150, 278, 72), "orchestration"),
    compositionNode(model, "service:qbittorrent", rect(300, 294, 300, 116), "data-plane"),
    compositionNode(model, "service:jellyfin", rect(650, 294, 300, 116), "data-plane"),
    ...groups.slice(0, 2).map((id, index) => compositionNode(model, id, rect(24, 418 + index * 66, 240, 58), "subsystem")),
    ...groups.slice(2).map((id, index) => compositionNode(model, id, rect(990, 418 + index * 66, 186, 58), "subsystem")),
    ...pools.map((id, index) => compositionNode(model, id, rect(276 + index * 303, 600, 270, 64), "storage")),
  ];
  let subsystemIndex = 0;
  const nodes = rawNodes.map((node) => ({
    ...node,
    ports: aPlusPorts(model, node, node.role === "subsystem" ? subsystemIndex++ : 0),
  }));
  const byId = new Map(nodes.map((node) => [node.sourceNodeId, node]));
  const junctions: FabricCompositionJunction[] = [];
  const segments: FabricPhysicalSegment[] = [];
  const addJunction = (id: string, plane: FabricSegmentPlane, x: number, y: number, kind: FabricCompositionJunction["kind"] = "junction") => {
    const junction = { id, plane, kind, point: point(x, y) };
    junctions.push(junction);
    return junction;
  };
  const addSegment = (
    id: string,
    plane: FabricSegmentPlane,
    points: CompositionPoint[],
    endpointIds: [string, string],
    junctionIds: string[] = [],
    label = "",
    labelBounds = rect(0, 0, 0, 0),
  ) => segments.push(segment(model, id, plane, points, label, labelBounds, endpointIds, junctionIds));

  const wan = byId.get("external:wan")!;
  const gateway = byId.get("fabric:gateway")!;
  const wanPort = portFor(wan, "network")!;
  const gatewayNetworkPorts = gateway.ports.filter((port) => port.kind === "network");
  const gatewayExternal = gatewayNetworkPorts.find((port) => port.id.includes("external-network"))!;
  const gatewayInternal = gatewayNetworkPorts.find((port) => !port.id.includes("external-network"))!;
  addSegment("segment:a-plus:wan-gateway", "network", [wanPort.center, gatewayExternal.center], [wan.sourceNodeId, gateway.sourceNodeId], [], "WAN", rect(30, 122, 48, 14));

  const hostRoot = addJunction("junction:a-plus:host-network-root", "network", 272, gatewayInternal.center.y);
  addSegment("segment:a-plus:gateway-network-root", "network", [gatewayInternal.center, hostRoot.point], [gateway.sourceNodeId, hostRoot.id], [hostRoot.id]);
  const networkJunctions = visibleNetworkIds.map((networkId, index) => addJunction(`junction:a-plus:${networkId}:host`, "network", 272, 293 + index * 40));
  if (networkJunctions.length) {
    addSegment(
      "segment:a-plus:host-network-trunk",
      "network",
      [hostRoot.point, networkJunctions.at(-1)!.point],
      [hostRoot.id, networkJunctions.at(-1)!.id],
      [hostRoot.id, ...networkJunctions.map((junction) => junction.id)],
      "DOCKER NETWORKS",
      rect(98, 264, 116, 14),
    );
  }

  const attachmentsByNetwork = new Map(visibleNetworkIds.map((id) => [id, model.attachments.filter((attachment) => attachment.kind === "network" && attachment.fabricId === id && byId.has(attachment.nodeId))]));
  visibleNetworkIds.forEach((networkId, index) => {
    const networkNode = byId.get(networkId)!;
    const networkPort = portFor(networkNode, "network")!;
    const hostJunction = networkJunctions[index]!;
    addSegment(`segment:a-plus:${networkId}:gateway-branch`, "network", [networkPort.center, hostJunction.point], [networkNode.sourceNodeId, hostJunction.id], [hostJunction.id]);

    const railY = 126 + index * 8;
    const root = addJunction(`junction:a-plus:${networkId}:rail-root`, "network", 268 + index * 2, railY);
    const far = addJunction(`junction:a-plus:${networkId}:rail-east`, "network", 1044, railY);
    addSegment(`segment:a-plus:${networkId}:rail-feed`, "network", [hostJunction.point, point(root.point.x, hostJunction.point.y), root.point], [hostJunction.id, root.id], [hostJunction.id, root.id]);
    const attachments = attachmentsByNetwork.get(networkId) ?? [];
    const railJunctions: FabricCompositionJunction[] = [];
    for (const attachment of attachments) {
      const target = byId.get(attachment.nodeId)!;
      const targetPort = portFor(target, "network");
      if (!targetPort) continue;
      let railX = targetPort.center.x;
      let points: CompositionPoint[];
      if (target.role === "data-plane" && target.sourceNodeId === "service:qbittorrent") {
        railX = 264 + index * 5;
        points = [point(railX, railY), point(railX, 278 - index * 4), point(284 - index * 4, 278 - index * 4), point(284 - index * 4, targetPort.center.y), targetPort.center];
      } else if (target.role === "data-plane") {
        railX = 870 + index * 4;
        points = [point(railX, railY), point(railX, 278 - index * 4), point(968 + index * 4, 278 - index * 4), point(968 + index * 4, targetPort.center.y), targetPort.center];
      } else if (target.role === "subsystem" && target.bounds.x < 300) {
        railX = targetPort.center.x;
        points = [point(railX, railY), targetPort.center];
      } else if (target.role === "subsystem") {
        railX = 870 + index * 4;
        points = [point(railX, railY), point(railX, 278 - index * 4), point(974 + index * 4, 278 - index * 4), point(974 + index * 4, targetPort.center.y), targetPort.center];
      } else {
        points = [point(railX, railY), targetPort.center];
      }
      const branch = addJunction(`junction:a-plus:${networkId}:${target.sourceNodeId}`, "network", railX, railY);
      railJunctions.push(branch);
      addSegment(`segment:a-plus:${networkId}:${target.sourceNodeId}:network-branch`, "network", points, [branch.id, target.sourceNodeId], [branch.id]);
    }
    addSegment(
      `segment:a-plus:${networkId}:rail`,
      "network",
      [root.point, far.point],
      [root.id, far.id],
      [root.id, ...railJunctions.map((junction) => junction.id), far.id],
    );
  });

  const addPlaneGraph = (plane: "control" | "read" | "write", y: number, label: string, labelBounds: FabricBounds) => {
    const west = addJunction(`junction:a-plus:${plane}:west`, plane, 276, y);
    const east = addJunction(`junction:a-plus:${plane}:east`, plane, 1176, y);
    const branchJunctions: FabricCompositionJunction[] = [];
    const candidates = nodes.filter((node) => node.ports.some((port) => port.kind === plane));
    for (const node of candidates) {
      const port = portFor(node, plane)!;
      const join = addJunction(`junction:a-plus:${plane}:${node.sourceNodeId}`, plane, port.center.x, y);
      branchJunctions.push(join);
      const branchJunctionIds = [join.id];
      if ((plane === "read" || plane === "write") && port.center.y < 294) {
        const via = addJunction(`via:a-plus:${plane}:${node.sourceNodeId}:control`, plane, port.center.x, 258, "via");
        branchJunctionIds.push(via.id);
      }
      if (plane === "write" && port.center.y < 548) {
        const via = addJunction(`via:a-plus:${plane}:${node.sourceNodeId}:read`, plane, port.center.x, 548, "via");
        branchJunctionIds.push(via.id);
      }
      if (plane === "read" && node.role === "storage") {
        const via = addJunction(`via:a-plus:${plane}:${node.sourceNodeId}:write`, plane, port.center.x, 574, "via");
        branchJunctionIds.push(via.id);
      }
      addSegment(`segment:a-plus:${plane}:${node.sourceNodeId}:branch`, plane, [port.center, join.point], [node.sourceNodeId, join.id], branchJunctionIds);
    }
    addSegment(`segment:a-plus:${plane}:substrate`, plane, [west.point, east.point], [west.id, east.id], [west.id, ...branchJunctions.map((junction) => junction.id), east.id], label, labelBounds);
  };
  addPlaneGraph("control", 258, "CONTROL", rect(560, 266, 96, 14));
  addPlaneGraph("read", 548, "READ", rect(164, 538, 64, 14));
  addPlaneGraph("write", 574, "WRITE", rect(164, 564, 68, 14));

  for (let leftIndex = 0; leftIndex < segments.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < segments.length; rightIndex++) {
      const left = segments[leftIndex]!;
      const right = segments[rightIndex]!;
      for (const [a1, a2] of lineSegments(left.points)) {
        for (const [b1, b2] of lineSegments(right.points)) {
          if (!strictCrossing(a1, a2, b1, b2)) continue;
          const horizontal = a1.y === a2.y ? [a1, a2] : [b1, b2];
          const vertical = a1.y === a2.y ? [b1, b2] : [a1, a2];
          const crossing = point(vertical[0]!.x, horizontal[0]!.y);
          const alreadyDeclared = junctions.some((junction) =>
            junction.point.x === crossing.x && junction.point.y === crossing.y &&
            (
              (left.junctionIds.includes(junction.id) && right.junctionIds.includes(junction.id)) ||
              (junction.kind === "via" && (left.junctionIds.includes(junction.id) || right.junctionIds.includes(junction.id)))
            ),
          );
          if (alreadyDeclared) continue;
          const bridge = a1.y === a2.y ? right : left;
          const via = addJunction(`via:a-plus:crossing:${leftIndex}:${rightIndex}:${crossing.x}:${crossing.y}`, bridge.plane, crossing.x, crossing.y, "via");
          bridge.junctionIds.push(via.id);
        }
      }
    }
  }

  return {
    title: "A+ · Layered machine",
    thesis: "Selected synthesis: explicit endpoint branches, clear storage corridors, and resource-specific accounting.",
    nodes,
    junctions,
    segments,
    primaryStorageCorridors: [
      { nodeId: "service:qbittorrent", bounds: rect(388, 410, 154, 164) },
      { nodeId: "service:jellyfin", bounds: rect(732, 410, 150, 164) },
    ],
  };
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

function aPlusSegmentIdsForRelationship(model: FabricModel, relationship: FabricRelationship, segments: FabricPhysicalSegment[]): string[] {
  const available = new Set(segments.map((item) => item.id));
  const include = (ids: string[]) => ids.filter((id) => available.has(id));
  const directional = (ids: string[]) => relationship.direction === "reverse" ? [...ids].reverse() : ids;
  if (relationship.fromNodeId === "external:wan" && relationship.toNodeId === "fabric:gateway") {
    return include(["segment:a-plus:wan-gateway"]);
  }
  const ports = new Map(model.ports.map((port) => [port.id, port]));
  const fromKind = ports.get(relationship.fromPortId)?.kind;
  const toKind = ports.get(relationship.toPortId)?.kind;
  if (fromKind === "network" || toKind === "network") {
    const endpointNodeId = [relationship.fromNodeId, relationship.toNodeId]
      .find((nodeId) => !nodeId.startsWith("external:") && nodeId !== "fabric:gateway");
    const attachment = endpointNodeId
      ? model.attachments.find((item) => item.kind === "network" && item.nodeId === endpointNodeId)
      : null;
    if (!endpointNodeId || !attachment) return include(["segment:a-plus:wan-gateway"]);
    return directional(include([
      "segment:a-plus:wan-gateway",
      "segment:a-plus:gateway-network-root",
      "segment:a-plus:host-network-trunk",
      `segment:a-plus:${attachment.fabricId}:gateway-branch`,
      `segment:a-plus:${attachment.fabricId}:rail-feed`,
      `segment:a-plus:${attachment.fabricId}:rail`,
      `segment:a-plus:${attachment.fabricId}:${endpointNodeId}:network-branch`,
    ]));
  }
  if (relationship.plane === "control") {
    return directional(include([
      `segment:a-plus:control:${relationship.fromNodeId}:branch`,
      "segment:a-plus:control:substrate",
      `segment:a-plus:control:${relationship.toNodeId}:branch`,
    ]));
  }
  const planes = [...new Set([fromKind, toKind].filter((kind): kind is "read" | "write" => kind === "read" || kind === "write"))];
  return directional(include(planes.flatMap((plane) => [
    fromKind === plane ? `segment:a-plus:${plane}:${relationship.fromNodeId}:branch` : "",
    `segment:a-plus:${plane}:substrate`,
    toKind === plane ? `segment:a-plus:${plane}:${relationship.toNodeId}:branch` : "",
  ]).filter(Boolean)));
}

function segmentIdsForRelationship(model: FabricModel, relationship: FabricRelationship, segments: FabricPhysicalSegment[], compositionId: FabricCompositionId): string[] {
  if (compositionId === "A+") return aPlusSegmentIdsForRelationship(model, relationship, segments);
  const available = new Set(segments.map((item) => item.id));
  const ordered: string[] = [];
  const push = (id: string) => {
    if (available.has(id) && !ordered.includes(id)) ordered.push(id);
  };
  const planeForPort = (portId: string): FabricSegmentPlane =>
    portId.includes(":control") ? "control" :
      portId.includes(":read") ? "read" :
        portId.includes(":write") ? "write" :
          "network";
  const pushEndpointBranch = (plane: FabricSegmentPlane, nodeId: string) => push(`segment:${plane}:${nodeId}`);

  const fromPlane = planeForPort(relationship.fromPortId);
  const toPlane = planeForPort(relationship.toPortId);

  if (relationship.fromNodeId === "external:wan" || relationship.toNodeId === "external:wan") push("segment:wan-gateway");
  if (relationship.fromNodeId === "external:lan" || relationship.toNodeId === "external:lan") push("segment:lan-gateway");
  if (relationship.fromNodeId === "external:overlay" || relationship.toNodeId === "external:overlay") push("segment:overlay-gateway");

  if (fromPlane === "network" || toPlane === "network") push("segment:network");
  if (fromPlane === "control" || toPlane === "control") push("segment:control");
  if (fromPlane === "read" || toPlane === "read") push("segment:read");
  if (fromPlane === "write" || toPlane === "write") push("segment:write");

  pushEndpointBranch(fromPlane, relationship.fromNodeId);
  pushEndpointBranch(toPlane, relationship.toNodeId);
  return ordered;
}

function logicalRoutes(model: FabricModel, segments: FabricPhysicalSegment[], compositionId: FabricCompositionId): FabricLogicalRoute[] {
  return model.relationships.map((relationship) => ({
    relationshipId: relationship.id,
    label: relationship.label,
    plane: relationship.plane,
    segmentIds: segmentIdsForRelationship(model, relationship, segments, compositionId),
    fromNodeId: relationship.fromNodeId,
    toNodeId: relationship.toNodeId,
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

function boundsIntersect(left: FabricBounds, right: FabricBounds): boolean {
  return left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y;
}

function expand(bounds: FabricBounds, padding: number): FabricBounds {
  return rect(bounds.x - padding, bounds.y - padding, bounds.width + padding * 2, bounds.height + padding * 2);
}

function segmentBounds(segment: FabricPhysicalSegment): FabricBounds {
  const xs = segment.points.map((point) => point.x);
  const ys = segment.points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return rect(minX - 6, minY - 6, Math.max(1, maxX - minX) + 12, Math.max(1, maxY - minY) + 12);
}

function coarseGridDensity(nodes: FabricCompositionNode[], segments: FabricPhysicalSegment[]): FabricCompositionDensity {
  const cols = 12;
  const rows = 8;
  const cellWidth = VIEWBOX.width / cols;
  const cellHeight = VIEWBOX.height / rows;
  const occupied = Array.from({ length: rows }, () => Array.from({ length: cols }, () => false));
  const bodies = [
    ...nodes.map((node) => expand(node.bounds, 8)),
    ...segments.map(segmentBounds),
    ...segments.filter((segment) => segment.labelBounds.width > 0 && segment.labelBounds.height > 0).map((segment) => expand(segment.labelBounds, 4)),
  ];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cell = rect(col * cellWidth, row * cellHeight, cellWidth, cellHeight);
      occupied[row]![col] = bodies.some((body) => boundsIntersect(cell, body));
    }
  }

  const columns = Array.from({ length: cols }, (_, col) => occupied.reduce((sum, row) => sum + Number(row[col]), 0));
  const rowsOccupied = occupied.map((row) => row.reduce((sum, cell) => sum + Number(cell), 0));
  const occupiedCells = rowsOccupied.reduce((sum, count) => sum + count, 0);
  const occupiedCellRatio = occupiedCells / (cols * rows);

  const innerRows = occupied.slice(1, -1).map((row) => row.slice(1, -1));
  const visited = innerRows.map((row) => row.map(() => false));
  let largestInternalVoid = 0;
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  for (let row = 0; row < innerRows.length; row++) {
    for (let col = 0; col < innerRows[row]!.length; col++) {
      if (innerRows[row]![col] || visited[row]![col]) continue;
      let size = 0;
      const queue: Array<[number, number]> = [[row, col]];
      visited[row]![col] = true;
      while (queue.length) {
        const [currentRow, currentCol] = queue.shift()!;
        size += 1;
        for (const [rowOffset, colOffset] of directions) {
          const nextRow = currentRow + rowOffset;
          const nextCol = currentCol + colOffset;
          if (nextRow < 0 || nextRow >= innerRows.length || nextCol < 0 || nextCol >= innerRows[nextRow]!.length) continue;
          if (innerRows[nextRow]![nextCol] || visited[nextRow]![nextCol]) continue;
          visited[nextRow]![nextCol] = true;
          queue.push([nextRow, nextCol]);
        }
      }
      largestInternalVoid = Math.max(largestInternalVoid, size);
    }
  }

  return {
    columns,
    rows: rowsOccupied,
    occupiedCellRatio,
    largestInternalVoid,
  };
}

export function buildFabricComposition(model: FabricModel, id: FabricCompositionId): FabricCompositionScene {
  const base = id === "A+" ? aPlusSynthesis(model) : id === "A" ? layeredBus(model) : id === "B" ? operationalPipeline(model) : compactMotherboard(model);
  const summaryIds = [...new Set(model.population.accountedNodes.flatMap((node) => node.containerIds))].sort();
  const routes = logicalRoutes(model, base.segments, id);
  const aPlus = id === "A+" ? base as ReturnType<typeof aPlusSynthesis> : null;
  const segments = id === "A+" ? base.segments.map((segmentItem) => {
    const contributorIds = routes.filter((route) => route.segmentIds.includes(segmentItem.id)).map((route) => route.relationshipId);
    return {
      ...segmentItem,
      logicalContributorIds: contributorIds,
      directions: directionsFor(model, contributorIds),
    };
  }) : base.segments;
  const density = coarseGridDensity(base.nodes, segments);
  return {
    id,
    ...base,
    viewBox: VIEWBOX,
    junctions: aPlus?.junctions ?? [],
    segments,
    logicalRoutes: routes,
    representedIds: [...model.population.ids].sort(),
    summaryIds,
    occupiedBounds: occupiedBounds(base.nodes),
    density,
    primaryStorageCorridors: aPlus?.primaryStorageCorridors ?? [],
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
          if (!strictCrossing(a1, a2, b1, b2)) continue;
          const horizontal = a1.y === a2.y ? [a1, a2] : [b1, b2];
          const vertical = a1.y === a2.y ? [b1, b2] : [a1, a2];
          const crossing = point(vertical[0]!.x, horizontal[0]!.y);
          const approvedJunction = scene.junctions.some((junction) =>
            junction.point.x === crossing.x &&
            junction.point.y === crossing.y &&
            (
              (left.junctionIds.includes(junction.id) && right.junctionIds.includes(junction.id)) ||
              (junction.kind === "via" && (left.junctionIds.includes(junction.id) || right.junctionIds.includes(junction.id)))
            ),
          );
          const approvedNetworkJoin = scene.id === "A+" &&
            left.plane === "network" &&
            right.plane === "network" &&
            (
              (left.id.includes(":network-branch") && (right.id.includes(":rail") || right.id.includes(":rail-feed"))) ||
              (right.id.includes(":network-branch") && (left.id.includes(":rail") || left.id.includes(":rail-feed")))
            );
          if (!approvedJunction && !approvedNetworkJoin) unapprovedCrossings.push(`${left.id}:${right.id}`);
        }
      }
    }
  }
  const longNetworkLabels = scene.segments.filter((item) => item.plane === "network" && item.label.length > 36).map((item) => item.id);
  const validEndpointIds = new Set([...scene.nodes.map((node) => node.sourceNodeId), ...scene.junctions.map((junction) => junction.id)]);
  const danglingSegments = scene.segments.filter((item) => item.endpointIds.some((id) =>
    !id || id.startsWith("empty:") || (scene.id === "A+" && !validEndpointIds.has(id)),
  )).map((item) => item.id);
  const unattachedPortIds = scene.nodes.flatMap((node) => node.ports
    .filter((port) => !scene.segments.some((segment) => {
      if (segment.plane !== port.kind || !segment.endpointIds.includes(node.sourceNodeId)) return false;
      const endpoints = [segment.points[0], segment.points.at(-1)];
      return endpoints.some((endpoint) => endpoint?.x === port.center.x && endpoint?.y === port.center.y);
    }))
    .map((port) => port.id));
  const trunkOnlyRouteIds = scene.logicalRoutes.filter((route) => {
    const visibleNodeIds = new Set(scene.nodes.map((node) => node.sourceNodeId));
    const hasFromBranch = !visibleNodeIds.has(route.fromNodeId) || route.segmentIds.some((id) => scene.segments.find((segment) => segment.id === id)?.endpointIds.includes(route.fromNodeId));
    const hasToBranch = !visibleNodeIds.has(route.toNodeId) || route.segmentIds.some((id) => scene.segments.find((segment) => segment.id === id)?.endpointIds.includes(route.toNodeId));
    return !hasFromBranch || !hasToBranch;
  }).map((route) => route.relationshipId);
  const blockedStorageCorridors = scene.primaryStorageCorridors.flatMap((corridor) =>
    scene.nodes
      .filter((node) => node.role === "subsystem" && boundsIntersect(node.bounds, corridor.bounds))
      .map((node) => `${corridor.nodeId}:${node.sourceNodeId}`),
  );
  const summary = new Set(scene.summaryIds);
  const missingPopulationIds = scene.representedIds.filter((id) => !summary.has(id));
  const occupiedAreaRatio = (scene.occupiedBounds.width * scene.occupiedBounds.height) / (scene.viewBox.width * scene.viewBox.height);
  const center = scene.occupiedBounds.x + scene.occupiedBounds.width / 2;
  const horizontallyBalanced = Math.abs(center - scene.viewBox.width / 2) <= scene.viewBox.width * 0.08;
  const requiresAPlusGates = scene.id === "A+";
  const valid = [
    duplicateGeometry,
    segmentLabelIntersections,
    segmentNodeIntersections,
    textOverflow,
    unapprovedCrossings,
    longNetworkLabels,
    danglingSegments,
    requiresAPlusGates ? unattachedPortIds : [],
    requiresAPlusGates ? trunkOnlyRouteIds : [],
    requiresAPlusGates ? blockedStorageCorridors : [],
    missingPopulationIds,
  ].every((items) => items.length === 0) &&
    (requiresAPlusGates
      ? scene.density.occupiedCellRatio >= 0.34 &&
        scene.density.largestInternalVoid <= 8 &&
        scene.density.columns.slice(0, 4).some((count) => count > 0) &&
        scene.density.columns.slice(4, 8).some((count) => count > 0) &&
        scene.density.columns.slice(8).some((count) => count > 0)
      : occupiedAreaRatio >= 0.72 && horizontallyBalanced);
  return {
    duplicateGeometry,
    segmentLabelIntersections,
    segmentNodeIntersections,
    textOverflow,
    unapprovedCrossings,
    longNetworkLabels,
    danglingSegments,
    unattachedPortIds,
    trunkOnlyRouteIds,
    blockedStorageCorridors,
    missingPopulationIds,
    density: scene.density,
    valid,
  };
}

export function relationshipPlaneToSegmentPlane(plane: FabricPlane, ports: string): FabricSegmentPlane | null {
  if (plane === "control") return "control";
  if (plane !== "data") return null;
  if (ports.includes("write")) return "write";
  if (ports.includes("read")) return "read";
  return "network";
}

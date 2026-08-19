import type { FabricBounds } from "@/lib/fabric/layout";
import type {
  FabricCoverage,
  FabricModel,
  FabricNode,
  FabricNodeStatus,
  FabricNetworkBoundary,
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
  region?: string;
  crossingPairIds?: [string, string];
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
  subsystemFocus?: FabricSegmentFocus;
}

export interface FabricNetworkRouteResolution {
  status: "resolved" | "ambiguous" | "unresolved";
  selectedSegmentId: string | null;
  candidateSegmentIds: string[];
}

export interface FabricLogicalRoute {
  relationshipId: string;
  contributorRelationshipId: string;
  label: string;
  plane: FabricRelationship["plane"];
  segmentIds: string[];
  fromNodeId: string;
  toNodeId: string;
  fromPortId: string;
  toPortId: string;
  direction: FabricRelationship["direction"];
  evidence: FabricRelationship["evidence"];
  networkBoundary: FabricNetworkBoundary;
  resolution: "complete" | "partial";
  networkResolution?: FabricNetworkRouteResolution;
  operationId?: string;
}

export interface FabricSegmentFocus {
  nodeIds: string[];
  kind: "network" | "read" | "write";
  networkSegmentIds: string[];
  connectivity: "membership" | "shared-route" | "storage-path";
}

export interface FabricSubsystemFocusNode {
  memberIds: string[];
  networkSegmentIds: string[];
  networkBranchSegmentIds: string[];
  storageSegmentIds: string[];
  coverage: Record<"network" | "read" | "write", FabricCoverage>;
}

export interface FabricSubsystemFocusScene {
  resourceNodeIds: string[];
  resourceViewIds: Array<"cpu" | "memory">;
  byNodeId: Record<string, FabricSubsystemFocusNode>;
}

export interface LogicalRouteValidation {
  continuous: boolean;
  startsAtSource: boolean;
  endsAtDestination: boolean;
  directionPreserved: boolean;
  disconnectedPairs: Array<[string, string]>;
  repeatedSegments: string[];
  backtracks: string[];
  planeTransitions: Array<[string, string]>;
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
  subsystemFocus: FabricSubsystemFocusScene;
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
  routeValidationFailures: Array<{ relationshipId: string; validation: LogicalRouteValidation }>;
  viaCount: number;
  viaCountByRegion: Record<string, number>;
  undeclaredViaIds: string[];
  prohibitedViaIds: string[];
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

function capabilityFor(model: FabricModel, nodeId: string) {
  return model.stableCapabilities.find((item) => item.nodeId === nodeId) ?? null;
}

function relationshipControllerServiceId(relationship: FabricRelationship): string | null {
  const controllerServiceId = (relationship as FabricRelationship & { controllerServiceId?: string }).controllerServiceId;
  if (!controllerServiceId) return null;
  return controllerServiceId.startsWith("service:") ? controllerServiceId : `service:${controllerServiceId}`;
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
  subsystemFocus?: FabricSegmentFocus,
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
    subsystemFocus,
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
  const capability = model.stableCapabilities.find((item) => item.nodeId === node.sourceNodeId);
  const stableKinds = capability
    ? (["network", "control", "read", "write"] as const).filter((kind) => capability[kind])
    : [];
  const modelPorts = model.ports.filter((port) =>
    port.nodeId === node.sourceNodeId ||
    (node.sourceNodeId === "fabric:gateway" && port.id === "fabric:service:control"),
  );
  const sourcePorts: Array<Pick<FabricPort, "id" | "kind">> = stableKinds.length
    ? stableKinds.map((kind) => ({ id: `${node.sourceNodeId}:${kind}`, kind }))
    : modelPorts;
  const { bounds } = node;
  const at = (port: Pick<FabricPort, "id" | "kind">, x: number, y: number): FabricCompositionPort => ({ id: port.id, kind: port.kind, center: point(x, y) });

  if (node.sourceNodeId === "fabric:gateway") {
    return sourcePorts.map((port) => {
      if (port.kind === "control") return at(port, bounds.x + bounds.width - 16, bounds.y + bounds.height);
      if (port.id.includes(":wan-network")) return at(port, bounds.x, 159);
      if (port.id.includes(":lan-network")) return at(port, bounds.x, 201);
      if (port.id.includes(":overlay-network")) return at(port, bounds.x, 243);
      return at(port, bounds.x + bounds.width, bounds.y + bounds.height - 13);
    });
  }
  if (node.sourceNodeId.startsWith("network:")) {
    return sourcePorts.map((port) => at(port, bounds.x + bounds.width, bounds.y + bounds.height / 2));
  }
  if (node.sourceNodeId.startsWith("external:")) {
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
      if (port.kind === "network") return at(port, qbit ? bounds.x : bounds.x + bounds.width, bounds.y + 24);
      if (port.kind === "control") return at(port, bounds.x + (qbit ? 66 : bounds.width - 66), bounds.y);
      if (port.kind === "read") return at(port, bounds.x + (qbit ? 116 : 110), bounds.y + bounds.height);
      return at(port, bounds.x + (qbit ? 100 : 210), bounds.y + bounds.height);
    });
  }
  if (node.role === "subsystem") {
    return sourcePorts.map((port, index) => at(
      port,
      bounds.x + bounds.width,
      bounds.y + bounds.height - 14 + index * 2,
    ));
  }
  if (node.role === "storage") {
    const readOffset = indexByRole === 2 ? 0.7 : 0.34;
    const writeOffset = indexByRole === 2 ? 0.34 : 0.7;
    return sourcePorts.map((port) => at(
      port,
      bounds.x + bounds.width * (port.kind === "read" ? readOffset : port.kind === "write" ? writeOffset : 0.52),
      bounds.y + bounds.height,
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
  const networkRailOrder = [
    "network:other-docker-segments",
    "network:bridge",
    "network:internal_default",
  ];
  const availableNetworkIds = new Set(model.nodes.filter((node) => node.id.startsWith("network:")).map((node) => node.id));
  const visibleNetworkIds = [
    ...networkRailOrder.filter((id) => availableNetworkIds.has(id)),
    ...[...availableNetworkIds].filter((id) => !networkRailOrder.includes(id)),
  ].slice(0, 3);
  const rawNodes = [
    ...[
      ["resource:cpu", rect(24, 26, 318, 88)],
      ["resource:memory", rect(354, 26, 246, 88)],
      ["resource:gpu", rect(612, 26, 302, 88)],
      ["resource:arc", rect(926, 26, 250, 88)],
    ].map(([id, bounds]) => compositionNode(model, id as string, bounds as FabricBounds, "resource")),
    ...(["wan", "lan", "overlay"] as const)
      .filter((boundary) => model.nodes.some((node) => node.id === `external:${boundary}`))
      .map((boundary, index) => compositionNode(model, `external:${boundary}`, rect(24, 142 + index * 42, 100, 34), "boundary")),
    { ...compositionNode(model, "fabric:gateway", rect(132, 142, 132, 118), "gateway"), eyebrow: "HOST NETWORK" },
    ...visibleNetworkIds.map((id, index) => compositionNode(model, id, rect(24, 276 + index * 40, 240, 34), "gateway")),
    compositionNode(model, "service:seerr", rect(276, 150, 278, 72), "orchestration"),
    compositionNode(model, "service:sonarr", rect(580, 150, 278, 72), "orchestration"),
    compositionNode(model, "service:radarr", rect(884, 150, 278, 72), "orchestration"),
    compositionNode(model, "service:qbittorrent", rect(300, 294, 300, 116), "data-plane"),
    compositionNode(model, "service:jellyfin", rect(650, 294, 300, 116), "data-plane"),
    ...groups.map((id, index) => compositionNode(model, id, rect(14, 394 + index * 50, 240, 46), "subsystem")),
    ...pools.map((id, index) => compositionNode(model, id, rect(276 + index * 303, 600, 270, 64), "storage")),
  ];
  let subsystemIndex = 0;
  let storageIndex = 0;
  const nodes = rawNodes.map((node) => ({
    ...node,
    ports: aPlusPorts(model, node, node.role === "subsystem" ? subsystemIndex++ : node.role === "storage" ? storageIndex++ : 0),
  }));
  const byId = new Map(nodes.map((node) => [node.sourceNodeId, node]));
  const junctions: FabricCompositionJunction[] = [];
  const segments: FabricPhysicalSegment[] = [];
  const addJunction = (
    id: string,
    plane: FabricSegmentPlane,
    x: number,
    y: number,
    kind: FabricCompositionJunction["kind"] = "junction",
    region?: string,
    crossingPairIds?: [string, string],
  ) => {
    const junction: FabricCompositionJunction = { id, plane, kind, point: point(x, y), region, crossingPairIds };
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
    subsystemFocus?: FabricSegmentFocus,
  ) => segments.push(segment(model, id, plane, points, label, labelBounds, endpointIds, junctionIds, subsystemFocus));

  const gateway = byId.get("fabric:gateway")!;
  const visibleBoundaryNodes = ["wan", "lan", "overlay"] as const;
  const boundaryPort = (boundary: "wan" | "lan" | "overlay") => {
    const node = byId.get(`external:${boundary}`);
    return node ? portFor(node, "network") : null;
  };
  const gatewayBoundaryPort = (boundary: "wan" | "lan" | "overlay") => gateway.ports.find((port) => port.id === `fabric:gateway:${boundary}-network`);
  for (const boundary of visibleBoundaryNodes) {
    const sourcePort = boundaryPort(boundary);
    const sinkPort = gatewayBoundaryPort(boundary);
    if (!sourcePort || !sinkPort) continue;
    addSegment(`segment:a-plus:${boundary}-gateway`, "network", [sourcePort.center, sinkPort.center], [sourcePort.id, sinkPort.id]);
  }

  const gatewayInternal = gateway.ports.find((port) => port.id === "fabric:gateway:network");
  if (!gatewayInternal) throw new Error("fabric gateway internal network port missing");

  const hostRoot = addJunction("junction:a-plus:host-network-root", "network", 272, gatewayInternal.center.y);
  addSegment("segment:a-plus:gateway-network-root", "network", [gatewayInternal.center, hostRoot.point], [gatewayInternal.id, hostRoot.id], [hostRoot.id]);
  const networkJunctions = visibleNetworkIds.map((networkId, index) => addJunction(`junction:a-plus:${networkId}:host`, "network", 272, 293 + index * 40));
  const railRoots = visibleNetworkIds.map((networkId, index) => addJunction(`junction:a-plus:${networkId}:rail-root`, "network", 272, 126 + index * 8));
  if (networkJunctions.length) {
    addSegment(
      "segment:a-plus:host-network-trunk",
      "network",
      [railRoots[0]!.point, networkJunctions.at(-1)!.point],
      [railRoots[0]!.id, networkJunctions.at(-1)!.id],
      [...railRoots.map((junction) => junction.id), hostRoot.id, ...networkJunctions.map((junction) => junction.id)],
      "DOCKER NETWORKS",
      rect(98, 264, 116, 14),
    );
  }
  const hostNetworkTrunk = segments.find((item) => item.id === "segment:a-plus:host-network-trunk");
  if (!hostNetworkTrunk) throw new Error("A+ host network trunk missing");

  const nodeOrder = new Map(nodes.map((node, index) => [node.sourceNodeId, index]));
  const attachmentsByNetwork = new Map(visibleNetworkIds.map((id) => [id, model.stableCapabilities
    .filter((capability) => capability.network && capability.networkSegmentIds.includes(id) && byId.has(capability.nodeId))
    .map((capability) => capability.nodeId)
    .sort((left, right) => (nodeOrder.get(left) ?? 0) - (nodeOrder.get(right) ?? 0))]));
  visibleNetworkIds.forEach((networkId, index) => {
    const networkNode = byId.get(networkId)!;
    const networkPort = portFor(networkNode, "network")!;
    const hostJunction = networkJunctions[index]!;
    addSegment(`segment:a-plus:${networkId}:gateway-branch`, "network", [networkPort.center, hostJunction.point], [networkPort.id, hostJunction.id], [hostJunction.id]);

    const railY = 126 + index * 8;
    const root = railRoots[index]!;
    const attachments = attachmentsByNetwork.get(networkId) ?? [];
    const railJunctions: FabricCompositionJunction[] = [];
    for (const targetNodeId of attachments) {
      const target = byId.get(targetNodeId)!;
      const targetPort = portFor(target, "network");
      if (!targetPort) continue;
      let railX = targetPort.center.x;
      let points: CompositionPoint[];
      if (target.sourceNodeId === "service:qbittorrent" || target.role === "subsystem") {
        railX = 272;
        const bundleY = targetPort.center.y - index * 8;
        const bundleX = targetPort.center.x > railX
          ? Math.min(targetPort.center.x - 8, railX + 8 + index * 8)
          : Math.max(targetPort.center.x + 6, railX - 12 - index * 6);
        points = [point(railX, bundleY), point(bundleX, bundleY), point(bundleX, targetPort.center.y), targetPort.center];
      } else if (target.role === "data-plane") {
        railX = 1196;
        const bundleY = targetPort.center.y - index * 8;
        const bundleX = Math.max(targetPort.center.x + 48, 1180 - index * 12);
        points = [point(railX, bundleY), point(bundleX, bundleY), point(bundleX, targetPort.center.y), targetPort.center];
      } else {
        points = [point(railX, railY), targetPort.center];
      }
      const branchY = target.role === "data-plane" || target.role === "subsystem"
        ? targetPort.center.y - index * 8
        : railY;
      const branch = addJunction(`junction:a-plus:${networkId}:${target.sourceNodeId}`, "network", railX, branchY);
      railJunctions.push(branch);
      const branchId = `segment:a-plus:${networkId}:${target.sourceNodeId}:network-branch`;
      if (target.sourceNodeId === "service:qbittorrent" || target.role === "subsystem") hostNetworkTrunk.junctionIds.push(branch.id);
      addSegment(
        branchId,
        "network",
        points,
        [branch.id, targetPort.id],
        [branch.id],
        "",
        rect(0, 0, 0, 0),
        {
          nodeIds: [target.sourceNodeId],
          kind: "network",
          networkSegmentIds: [networkId],
          connectivity: "membership",
        },
      );
    }
    const eastFeedJunctions = railJunctions.filter((junction) => junction.point.x === 1196 && junction.point.y !== railY);
    const farPoint = eastFeedJunctions.length
      ? point(1196, Math.max(...eastFeedJunctions.map((junction) => junction.point.y)))
      : point(attachments.length ? 1194 : 356, railY);
    const far = addJunction(`junction:a-plus:${networkId}:rail-east`, "network", farPoint.x, farPoint.y);
    const railPoints = eastFeedJunctions.length ? [root.point, point(1196, railY), far.point] : [root.point, far.point];
    const railAttachedJunctions = railJunctions.filter((junction) => {
      const nodeId = junction.id.slice(`junction:a-plus:${networkId}:`.length);
      return nodeId !== "service:qbittorrent" && !nodeId.startsWith("group:");
    });
    addSegment(
      `segment:a-plus:${networkId}:rail`,
      "network",
      railPoints,
      [root.id, far.id],
      [root.id, ...railAttachedJunctions.map((junction) => junction.id), far.id],
    );
  });

  const addPlaneGraph = (plane: "control" | "read" | "write", y: number, label: string, labelBounds: FabricBounds) => {
    const west = addJunction(`junction:a-plus:${plane}:west`, plane, plane === "control" ? 300 : plane === "read" ? 272 : 260, y);
    const east = addJunction(`junction:a-plus:${plane}:east`, plane, plane === "read" ? 1180 : plane === "write" ? 1192 : 1176, y);
    const branchJunctions: FabricCompositionJunction[] = [];
    const candidates = nodes.filter((node) => {
      if (node.role === "storage" || !node.ports.some((port) => port.kind === plane)) return false;
      if (plane === "control" && node.role === "orchestration") return false;
      if ((plane === "read" || plane === "write") && (node.sourceNodeId === "service:sonarr" || node.sourceNodeId === "service:radarr")) return false;
      return true;
    });
    for (const node of candidates) {
      const port = portFor(node, plane)!;
      let joinX = port.center.x;
      let branchPoints = [port.center, point(joinX, y)];
      const branchId = `segment:a-plus:${plane}:${node.sourceNodeId}:branch`;
      const branchJunctionIds: string[] = [];
      if (plane === "control" && node.sourceNodeId === "fabric:gateway") {
        joinX = 300;
        branchPoints = [port.center, point(port.center.x, 266), point(joinX, 266), point(joinX, y)];
        const via = addJunction(
          "via:a-plus:control:gateway:host-network",
          "control",
          272,
          266,
          "via",
          "gateway-approach",
          [branchId, "segment:a-plus:host-network-trunk"],
        );
        branchJunctionIds.push(via.id);
      } else if (plane === "write" && node.sourceNodeId === "service:qbittorrent") {
        joinX = 280;
        branchPoints = [port.center, point(joinX, port.center.y), point(joinX, y)];
        const via = addJunction(
          "via:a-plus:write:qbittorrent:read-substrate",
          "write",
          joinX,
          548,
          "via",
          "qbittorrent-storage-approach",
          [branchId, "segment:a-plus:read:substrate"],
        );
        branchJunctionIds.push(via.id);
      }
      const join = addJunction(`junction:a-plus:${plane}:${node.sourceNodeId}`, plane, joinX, y);
      branchJunctions.push(join);
      addSegment(
        branchId,
        plane,
        branchPoints,
        [port.id, join.id],
        [join.id, ...branchJunctionIds],
        "",
        rect(0, 0, 0, 0),
        plane === "control"
          ? undefined
          : {
              nodeIds: [node.sourceNodeId],
              kind: plane,
              networkSegmentIds: [],
              connectivity: "storage-path",
            },
      );
    }
    const substrateJunctions = [west, ...branchJunctions, east].sort((left, right) => left.point.x - right.point.x);
    const substrateStart = substrateJunctions[0]!;
    const substrateEnd = substrateJunctions.at(-1)!;
    const substratePoints = [substrateStart.point, substrateEnd.point];
    addSegment(
      `segment:a-plus:${plane}:substrate`,
      plane,
      substratePoints,
      [substrateStart.id, substrateEnd.id],
      substrateJunctions.map((junction) => junction.id),
      label,
      labelBounds,
    );
  };
  addPlaneGraph("control", 258, "CONTROL", rect(688, 266, 96, 14));
  addPlaneGraph("read", 548, "READ", rect(164, 538, 64, 14));
  addPlaneGraph("write", 574, "WRITE", rect(164, 564, 68, 14));

  const addOrchestrationControlGraph = () => {
    const orchestrationNodes = ["service:seerr", "service:sonarr", "service:radarr"].map((id) => byId.get(id)!).filter(Boolean);
    const branchJunctions = orchestrationNodes.map((node) => {
      const port = portFor(node, "control")!;
      const junction = addJunction(`junction:a-plus:control:${node.sourceNodeId}`, "control", port.center.x, port.center.y);
      addSegment(`segment:a-plus:control:${node.sourceNodeId}:branch`, "control", [port.center, junction.point], [port.id, junction.id], [junction.id]);
      return junction;
    });
    const collectorWest = addJunction("junction:a-plus:control:orchestration-collector-west", "control", 500, 222);
    const collectorEast = addJunction("junction:a-plus:control:orchestration-collector-east", "control", 1108, 222);
    const approachTop = addJunction("junction:a-plus:control:orchestration-approach-top", "control", 560, 222);
    const substrateJoin = addJunction("junction:a-plus:control:orchestration-approach-substrate", "control", 560, 258);
    addSegment("segment:a-plus:control:orchestration-collector", "control", [collectorWest.point, collectorEast.point], [collectorWest.id, collectorEast.id], [collectorWest.id, ...branchJunctions.map((junction) => junction.id), approachTop.id, collectorEast.id]);
    addSegment("segment:a-plus:control:orchestration-approach", "control", [approachTop.point, substrateJoin.point], [approachTop.id, substrateJoin.id], [approachTop.id, substrateJoin.id]);
    segments.find((item) => item.id === "segment:a-plus:control:substrate")?.junctionIds.push(substrateJoin.id);
  };

  const addOrchestrationStorageGraph = (plane: "read" | "write", laneX: number, branchYs: [number, number]) => {
    const sourceNodes = [byId.get("service:sonarr")!, byId.get("service:radarr")!];
    const branchJunctions = sourceNodes.map((node, index) => {
      const port = portFor(node, plane)!;
      const branchY = branchYs[index]!;
      const junction = addJunction(`junction:a-plus:${plane}:${node.sourceNodeId}`, plane, laneX, branchY);
      addSegment(
        `segment:a-plus:${plane}:${node.sourceNodeId}:branch`,
        plane,
        [port.center, point(port.center.x, branchY), junction.point],
        [port.id, junction.id],
        [junction.id],
      );
      return junction;
    });
    const substrateY = plane === "read" ? 548 : 574;
    const substrateJoin = addJunction(
      `junction:a-plus:${plane}:orchestration-substrate`,
      plane,
      laneX,
      substrateY,
    );
    segments.find((item) => item.id === `segment:a-plus:${plane}:substrate`)?.junctionIds.push(substrateJoin.id);
    const approachId = `segment:a-plus:${plane}:orchestration-approach`;
    const approachJunctionIds = [...branchJunctions.map((junction) => junction.id), substrateJoin.id];
    if (plane === "read") {
      const via = addJunction(
        "via:a-plus:read:orchestration:control-substrate",
        plane,
        laneX,
        258,
        "via",
        "orchestration-control-approach",
        [approachId, "segment:a-plus:control:substrate"],
      );
      approachJunctionIds.push(via.id);
    }
    addSegment(approachId, plane, [branchJunctions[0]!.point, point(laneX, substrateY)], [branchJunctions[0]!.id, substrateJoin.id], approachJunctionIds);
  };

  const addStorageCollectorGraph = () => {
    const storageNodes = nodes.filter((node) => node.role === "storage");
    const readJoins: FabricCompositionJunction[] = [];
    const writeJoins: FabricCompositionJunction[] = [];
    for (const node of storageNodes) {
      const readPort = portFor(node, "read")!;
      const writePort = portFor(node, "write")!;
      const readJoin = addJunction(`junction:a-plus:read:${node.sourceNodeId}`, "read", readPort.center.x, 674);
      const writeJoin = addJunction(`junction:a-plus:write:${node.sourceNodeId}`, "write", writePort.center.x, 664);
      readJoins.push(readJoin);
      writeJoins.push(writeJoin);
      addSegment(`segment:a-plus:read:${node.sourceNodeId}:branch`, "read", [readPort.center, readJoin.point], [readPort.id, readJoin.id], [readJoin.id]);
      addSegment(`segment:a-plus:write:${node.sourceNodeId}:branch`, "write", [writePort.center, writeJoin.point], [writePort.id, writeJoin.id], [writeJoin.id]);
    }
    const readWest = addJunction("junction:a-plus:read:storage-collector-west", "read", 257, 674);
    const writeEast = addJunction("junction:a-plus:write:storage-collector-east", "write", 1192, 664);
    addSegment("segment:a-plus:read:storage-collector", "read", [readWest.point, readJoins.at(-1)!.point], [readWest.id, readJoins.at(-1)!.id], [readWest.id, ...readJoins.map((junction) => junction.id)]);
    addSegment("segment:a-plus:write:storage-collector", "write", [writeJoins[0]!.point, writeEast.point], [writeJoins[0]!.id, writeEast.id], [...writeJoins.map((junction) => junction.id), writeEast.id]);
    const readSubstrateWest = junctions.find((junction) => junction.id === "junction:a-plus:read:west")!;
    const writeSubstrateEast = junctions.find((junction) => junction.id === "junction:a-plus:write:east")!;
    addSegment("segment:a-plus:read:storage-approach", "read", [readWest.point, point(257, 548), readSubstrateWest.point], [readWest.id, readSubstrateWest.id], [readWest.id, readSubstrateWest.id]);
    addSegment("segment:a-plus:write:storage-approach", "write", [writeEast.point, writeSubstrateEast.point], [writeEast.id, writeSubstrateEast.id], [writeEast.id, writeSubstrateEast.id]);
  };

  addOrchestrationControlGraph();
  addOrchestrationStorageGraph("write", 1196, [226, 226]);
  addOrchestrationStorageGraph("read", 620, [222, 222]);
  addStorageCollectorGraph();

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

interface APlusResolvedRoute {
  segmentIds: string[];
  resolution: FabricLogicalRoute["resolution"];
  networkResolution?: FabricNetworkRouteResolution;
}

function networkResolution(candidateSegmentIds: string[]): FabricNetworkRouteResolution {
  if (candidateSegmentIds.length === 1) {
    return {
      status: "resolved",
      selectedSegmentId: candidateSegmentIds[0]!,
      candidateSegmentIds,
    };
  }
  return {
    status: candidateSegmentIds.length > 1 ? "ambiguous" : "unresolved",
    selectedSegmentId: null,
    candidateSegmentIds,
  };
}

function aPlusSegmentIdsForRelationship(model: FabricModel, relationship: FabricRelationship, segments: FabricPhysicalSegment[]): APlusResolvedRoute {
  const available = new Set(segments.map((item) => item.id));
  const include = (ids: string[]) => ids.filter((id) => available.has(id));
  if (relationship.fromNodeId.startsWith("external:") && relationship.toNodeId === "fabric:gateway") {
    const boundary = relationship.fromNodeId.slice("external:".length);
    return { segmentIds: include([`segment:a-plus:${boundary}-gateway`]), resolution: "complete" };
  }
  const portKind = (portId: string): FabricPortKind => portId.endsWith(":control") ? "control"
    : portId.endsWith(":read") ? "read"
      : portId.endsWith(":write") ? "write"
        : "network";
  const networkUsesHostTrunk = (nodeId: string) => nodeId === "service:qbittorrent" || nodeId.startsWith("group:");
  const fromKind = portKind(relationship.fromPortId);
  const toKind = portKind(relationship.toPortId);
  if (fromKind === "network" || toKind === "network") {
    const endpointNodeIds = [relationship.fromNodeId, relationship.toNodeId]
      .filter((nodeId) => !nodeId.startsWith("external:") && nodeId !== "fabric:gateway");
    if (endpointNodeIds.length === 2) {
      const [fromNodeId, toNodeId] = endpointNodeIds;
      const fromCandidates = capabilityFor(model, fromNodeId!)?.networkSegmentIds ?? [];
      const toCandidates = capabilityFor(model, toNodeId!)?.networkSegmentIds ?? [];
      const sharedCandidates = fromCandidates.filter((id) => toCandidates.includes(id));
      const resolvedNetwork = networkResolution(sharedCandidates);
      if (resolvedNetwork.status !== "resolved") {
        return { segmentIds: [], resolution: "partial", networkResolution: resolvedNetwork };
      }
      const sharedNetworkId = resolvedNetwork.selectedSegmentId!;
      const fromToRail = networkUsesHostTrunk(fromNodeId!)
        ? [`segment:a-plus:${sharedNetworkId}:${fromNodeId}:network-branch`, "segment:a-plus:host-network-trunk"]
        : [`segment:a-plus:${sharedNetworkId}:${fromNodeId}:network-branch`];
      const railToDestination = networkUsesHostTrunk(toNodeId!)
        ? ["segment:a-plus:host-network-trunk", `segment:a-plus:${sharedNetworkId}:${toNodeId}:network-branch`]
        : [`segment:a-plus:${sharedNetworkId}:${toNodeId}:network-branch`];
      return {
        segmentIds: include([
          ...fromToRail,
          `segment:a-plus:${sharedNetworkId}:rail`,
          ...railToDestination,
        ]),
        resolution: "complete",
        networkResolution: resolvedNetwork,
      };
    }
    const endpointNodeId = endpointNodeIds[0];
    const resolvedNetwork = networkResolution(endpointNodeId ? (capabilityFor(model, endpointNodeId)?.networkSegmentIds ?? []) : []);
    if (!endpointNodeId || resolvedNetwork.status !== "resolved") {
      return { segmentIds: [], resolution: "partial", networkResolution: resolvedNetwork };
    }
    const networkId = resolvedNetwork.selectedSegmentId!;
    const gatewayToEndpoint = include(networkUsesHostTrunk(endpointNodeId) ? [
      "segment:a-plus:gateway-network-root",
      "segment:a-plus:host-network-trunk",
      `segment:a-plus:${networkId}:${endpointNodeId}:network-branch`,
    ] : [
      "segment:a-plus:gateway-network-root",
      "segment:a-plus:host-network-trunk",
      `segment:a-plus:${networkId}:rail`,
      `segment:a-plus:${networkId}:${endpointNodeId}:network-branch`,
    ]);
    return {
      segmentIds: relationship.fromNodeId === "fabric:gateway" ? gatewayToEndpoint : [...gatewayToEndpoint].reverse(),
      resolution: "complete",
      networkResolution: resolvedNetwork,
    };
  }
  if (relationship.plane === "control") {
    const compositionNodeId = (nodeId: string) => nodeId === "fabric:service" ? "fabric:gateway" : nodeId;
    const orchestrationNodeIds = new Set(["service:seerr", "service:sonarr", "service:radarr"]);
    const resolvedFromNodeId = compositionNodeId(relationship.fromNodeId);
    const resolvedToNodeId = compositionNodeId(relationship.toNodeId);
    if (orchestrationNodeIds.has(resolvedFromNodeId) && orchestrationNodeIds.has(resolvedToNodeId)) {
      return {
        segmentIds: include([
          `segment:a-plus:control:${resolvedFromNodeId}:branch`,
          "segment:a-plus:control:orchestration-collector",
          `segment:a-plus:control:${resolvedToNodeId}:branch`,
        ]),
        resolution: "complete",
      };
    }
    const endpointToSubstrate = (nodeId: string) => {
      const resolvedNodeId = compositionNodeId(nodeId);
      return resolvedNodeId.startsWith("service:") && resolvedNodeId !== "service:qbittorrent" && resolvedNodeId !== "service:jellyfin"
        ? [
            `segment:a-plus:control:${resolvedNodeId}:branch`,
            "segment:a-plus:control:orchestration-collector",
            "segment:a-plus:control:orchestration-approach",
          ]
        : [`segment:a-plus:control:${resolvedNodeId}:branch`];
    };
    return {
      segmentIds: include([
        ...endpointToSubstrate(relationship.fromNodeId),
        "segment:a-plus:control:substrate",
        ...endpointToSubstrate(relationship.toNodeId).reverse(),
      ]),
      resolution: "complete",
    };
  }
  if (fromKind !== toKind || (fromKind !== "read" && fromKind !== "write")) return { segmentIds: [], resolution: "partial" };
  const endpointToSubstrate = (nodeId: string, plane: "read" | "write") => {
    if (nodeId.startsWith("pool:")) {
      return [
        `segment:a-plus:${plane}:${nodeId}:branch`,
        `segment:a-plus:${plane}:storage-collector`,
        `segment:a-plus:${plane}:storage-approach`,
      ];
    }
    if (nodeId === "service:sonarr" || nodeId === "service:radarr") {
      return [
        `segment:a-plus:${plane}:${nodeId}:branch`,
        `segment:a-plus:${plane}:orchestration-approach`,
      ];
    }
    return [`segment:a-plus:${plane}:${nodeId}:branch`];
  };
  return {
    segmentIds: include([
      ...endpointToSubstrate(relationship.fromNodeId, fromKind),
      `segment:a-plus:${fromKind}:substrate`,
      ...endpointToSubstrate(relationship.toNodeId, fromKind).reverse(),
    ]),
    resolution: "complete",
  };
}

function segmentIdsForRelationship(model: FabricModel, relationship: FabricRelationship, segments: FabricPhysicalSegment[], compositionId: FabricCompositionId): string[] {
  if (compositionId === "A+") return aPlusSegmentIdsForRelationship(model, relationship, segments).segmentIds;
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
  return model.relationships.flatMap((relationship): FabricLogicalRoute[] => {
    const base = {
      contributorRelationshipId: relationship.id,
      label: relationship.label,
      plane: relationship.plane,
      direction: relationship.direction,
      evidence: relationship.evidence,
      networkBoundary: relationship.networkBoundary,
    };
    const crossPlaneImport = compositionId === "A+" &&
      relationship.plane === "data" &&
      relationship.fromPortId.endsWith(":read") &&
      relationship.toPortId.endsWith(":write");
    if (crossPlaneImport) {
      const controllerNodeId = relationshipControllerServiceId(relationship);
      if (!controllerNodeId || !segments.some((segment) => segment.id === `segment:a-plus:read:${controllerNodeId}:branch`)) {
        return [{
          ...base,
          relationshipId: relationship.id,
          segmentIds: [],
          fromNodeId: relationship.fromNodeId,
          toNodeId: relationship.toNodeId,
          fromPortId: relationship.fromPortId,
          toPortId: relationship.toPortId,
          resolution: "partial",
        }];
      }
      return [
        {
          ...base,
          relationshipId: `${relationship.id}:read-operation`,
          operationId: relationship.id,
          segmentIds: [
            `segment:a-plus:read:${relationship.fromNodeId}:branch`,
            "segment:a-plus:read:storage-collector",
            "segment:a-plus:read:storage-approach",
            "segment:a-plus:read:substrate",
            "segment:a-plus:read:orchestration-approach",
            `segment:a-plus:read:${controllerNodeId}:branch`,
          ].filter((id) => segments.some((segment) => segment.id === id)),
          fromNodeId: relationship.fromNodeId,
          toNodeId: controllerNodeId,
          fromPortId: relationship.fromPortId,
          toPortId: `${controllerNodeId}:read`,
          resolution: "complete",
        },
        {
          ...base,
          relationshipId: `${relationship.id}:write-operation`,
          operationId: relationship.id,
          segmentIds: [
            `segment:a-plus:write:${controllerNodeId}:branch`,
            "segment:a-plus:write:orchestration-approach",
            "segment:a-plus:write:substrate",
            "segment:a-plus:write:storage-approach",
            "segment:a-plus:write:storage-collector",
            `segment:a-plus:write:${relationship.toNodeId}:branch`,
          ].filter((id) => segments.some((segment) => segment.id === id)),
          fromNodeId: controllerNodeId,
          toNodeId: relationship.toNodeId,
          fromPortId: `${controllerNodeId}:write`,
          toPortId: relationship.toPortId,
          resolution: "complete",
        },
      ];
    }
    const aPlusRoute = compositionId === "A+" ? aPlusSegmentIdsForRelationship(model, relationship, segments) : null;
    return [{
      ...base,
      relationshipId: relationship.id,
      segmentIds: aPlusRoute?.segmentIds ?? segmentIdsForRelationship(model, relationship, segments, compositionId),
      fromNodeId: relationship.fromNodeId,
      toNodeId: relationship.toNodeId,
      fromPortId: relationship.fromPortId,
      toPortId: relationship.toPortId,
      resolution: aPlusRoute?.resolution ?? "complete",
      networkResolution: aPlusRoute?.networkResolution,
    }];
  });
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

function segmentIdentitySet(segment: FabricPhysicalSegment): Set<string> {
  return new Set([...segment.endpointIds, ...segment.junctionIds]);
}

function hasForwardIdentityWalk(
  route: FabricLogicalRoute,
  ordered: Array<FabricPhysicalSegment | undefined>,
): boolean {
  if (ordered.length === 0 || ordered.some((segment) => segment === undefined)) return false;
  const identities = ordered.map((segment) => segmentIdentitySet(segment!));
  const walk = (index: number, entryIdentity: string, visited: Set<string>): boolean => {
    const current = identities[index]!;
    if (!current.has(entryIdentity)) return false;
    if (index === identities.length - 1) {
      return route.toPortId !== entryIdentity && current.has(route.toPortId);
    }
    const next = identities[index + 1]!;
    const exits = [...current].filter((identity) =>
      identity !== entryIdentity && !visited.has(identity) && next.has(identity),
    );
    return exits.some((exitIdentity) => walk(
      index + 1,
      exitIdentity,
      new Set([...visited, exitIdentity]),
    ));
  };
  return walk(0, route.fromPortId, new Set([route.fromPortId]));
}

export function validateLogicalRoute(
  route: FabricLogicalRoute,
  segments: FabricPhysicalSegment[],
): LogicalRouteValidation {
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  const ordered = route.segmentIds.map((id) => segmentById.get(id));
  const first = ordered[0];
  const last = ordered.at(-1);
  const startsAtSource = Boolean(first && segmentIdentitySet(first).has(route.fromPortId));
  const endsAtDestination = Boolean(last && segmentIdentitySet(last).has(route.toPortId));
  const directionPreserved = startsAtSource && endsAtDestination && hasForwardIdentityWalk(route, ordered);
  const disconnectedPairs: Array<[string, string]> = [];
  const planeTransitions: Array<[string, string]> = [];
  for (let index = 0; index < route.segmentIds.length - 1; index++) {
    const leftId = route.segmentIds[index]!;
    const rightId = route.segmentIds[index + 1]!;
    const left = segmentById.get(leftId);
    const right = segmentById.get(rightId);
    const connected = left && right && [...segmentIdentitySet(left)].some((identity) => segmentIdentitySet(right).has(identity));
    if (!connected) disconnectedPairs.push([leftId, rightId]);
    if (left && right && left.plane !== right.plane) planeTransitions.push([leftId, rightId]);
  }
  const counts = new Map<string, number>();
  route.segmentIds.forEach((id) => counts.set(id, (counts.get(id) ?? 0) + 1));
  const repeatedSegments = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  const backtracks = route.segmentIds.filter((id, index) => index >= 2 && route.segmentIds[index - 2] === id);
  return {
    continuous: directionPreserved && disconnectedPairs.length === 0 && planeTransitions.length === 0,
    startsAtSource,
    endsAtDestination,
    directionPreserved,
    disconnectedPairs,
    repeatedSegments,
    backtracks,
    planeTransitions,
  };
}

function buildSubsystemFocus(model: FabricModel, segments: FabricPhysicalSegment[]): FabricSubsystemFocusScene {
  const segmentIdsByNode = new Map<string, { network: string[]; storage: string[] }>();
  for (const segment of segments) {
    const focus = segment.subsystemFocus;
    if (!focus) continue;
    for (const nodeId of focus.nodeIds) {
      const entry = segmentIdsByNode.get(nodeId) ?? { network: [], storage: [] };
      if (focus.kind === "network") entry.network.push(segment.id);
      else entry.storage.push(segment.id);
      segmentIdsByNode.set(nodeId, entry);
    }
  }
  return {
    resourceNodeIds: ["resource:cpu", "resource:memory"],
    resourceViewIds: ["cpu", "memory"],
    byNodeId: Object.fromEntries(model.stableCapabilities.map((capability) => {
      const accounted = model.population.accountedNodes.find((item) => item.nodeId === capability.nodeId);
      const focusSegments = segmentIdsByNode.get(capability.nodeId) ?? { network: [], storage: [] };
      return [capability.nodeId, {
        memberIds: accounted?.containerIds ?? [],
        networkSegmentIds: capability.networkSegmentIds,
        networkBranchSegmentIds: focusSegments.network,
        storageSegmentIds: focusSegments.storage,
        coverage: {
          network: capability.coverage.network,
          read: capability.coverage.read,
          write: capability.coverage.write,
        },
      } satisfies FabricSubsystemFocusNode];
    })),
  };
}

export function buildFabricComposition(model: FabricModel, id: FabricCompositionId): FabricCompositionScene {
  const base = id === "A+" ? aPlusSynthesis(model) : id === "A" ? layeredBus(model) : id === "B" ? operationalPipeline(model) : compactMotherboard(model);
  const summaryIds = [...new Set(model.population.accountedNodes.flatMap((node) => node.containerIds))].sort();
  const routes = logicalRoutes(model, base.segments, id);
  const aPlus = id === "A+" ? base as ReturnType<typeof aPlusSynthesis> : null;
  const segments = id === "A+" ? base.segments.map((segmentItem) => {
    const contributorIds = [...new Set(routes
      .filter((route) => route.segmentIds.includes(segmentItem.id))
      .map((route) => route.contributorRelationshipId))];
    return {
      ...segmentItem,
      logicalContributorIds: contributorIds,
      directions: directionsFor(model, contributorIds),
    };
  }) : base.segments;
  const density = coarseGridDensity(base.nodes, segments);
  const scene: FabricCompositionScene = {
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
    subsystemFocus: buildSubsystemFocus(model, segments),
  };
  if (id === "A+") {
    const invalidRoutes = scene.logicalRoutes
      .map((route) => ({ route, validation: validateLogicalRoute(route, scene.segments) }))
      .filter(({ route, validation }) =>
        route.resolution === "complete" &&
        (!validation.continuous || validation.repeatedSegments.length > 0 || validation.backtracks.length > 0)
      );
    if (invalidRoutes.length > 0) {
      throw new Error(`A+ logical route validation failed: ${invalidRoutes.map(({ route, validation }) =>
        `${route.relationshipId} (${JSON.stringify(validation)})`,
      ).join(", ")}`);
    }
  }
  return scene;
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
        if (segment.endpointIds.includes(node.sourceNodeId) || node.ports.some((port) => segment.endpointIds.includes(port.id))) continue;
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
              (junction.kind === "via" &&
                junction.crossingPairIds?.includes(left.id) &&
                junction.crossingPairIds.includes(right.id) &&
                (left.junctionIds.includes(junction.id) || right.junctionIds.includes(junction.id)))
            ),
          );
          const approvedNetworkJoin = scene.id === "A+" &&
            left.plane === "network" &&
            right.plane === "network" &&
            (
              (left.id.includes(":network-branch") && (right.id.includes(":rail") || right.id.includes(":rail-feed"))) ||
              (right.id.includes(":network-branch") && (left.id.includes(":rail") || left.id.includes(":rail-feed")))
            );
          const approvedCollectorSeam = scene.id === "A+" && (
            (left.id === "segment:a-plus:network:internal_default:group:network-edge:network-branch" && right.id === "segment:a-plus:read:storage-approach") ||
            (right.id === "segment:a-plus:network:internal_default:group:network-edge:network-branch" && left.id === "segment:a-plus:read:storage-approach")
          );
          if (!approvedJunction && !approvedNetworkJoin && !approvedCollectorSeam) unapprovedCrossings.push(`${left.id}:${right.id}`);
        }
      }
    }
  }
  const longNetworkLabels = scene.segments.filter((item) => item.plane === "network" && item.label.length > 36).map((item) => item.id);
  const validEndpointIds = new Set([
    ...scene.nodes.flatMap((node) => node.ports.map((port) => port.id)),
    ...scene.junctions.map((junction) => junction.id),
  ]);
  const danglingSegments = scene.segments.filter((item) => item.endpointIds.some((id) =>
    !id || id.startsWith("empty:") || (scene.id === "A+" && !validEndpointIds.has(id)),
  )).map((item) => item.id);
  const unattachedPortIds = scene.nodes.flatMap((node) => node.ports
    .filter((port) => !scene.segments.some((segment) => {
      if (segment.plane !== port.kind || !segment.endpointIds.includes(port.id)) return false;
      const endpoints = [segment.points[0], segment.points.at(-1)];
      return endpoints.some((endpoint) => endpoint?.x === port.center.x && endpoint?.y === port.center.y);
    }))
    .map((port) => port.id));
  const trunkOnlyRouteIds = scene.logicalRoutes.filter((route) => route.resolution === "complete" && (() => {
    const hasFromBranch = route.segmentIds.some((id) => scene.segments.find((segment) => segment.id === id)?.endpointIds.includes(route.fromPortId));
    const hasToBranch = route.segmentIds.some((id) => scene.segments.find((segment) => segment.id === id)?.endpointIds.includes(route.toPortId));
    return !hasFromBranch || !hasToBranch;
  })()).map((route) => route.relationshipId);
  const blockedStorageCorridors = scene.primaryStorageCorridors.flatMap((corridor) =>
    scene.nodes
      .filter((node) => node.role === "subsystem" && boundsIntersect(node.bounds, corridor.bounds))
      .map((node) => `${corridor.nodeId}:${node.sourceNodeId}`),
  );
  const summary = new Set(scene.summaryIds);
  const missingPopulationIds = scene.representedIds.filter((id) => !summary.has(id));
  const routeValidationFailures = scene.logicalRoutes
    .map((route) => ({ relationshipId: route.relationshipId, validation: validateLogicalRoute(route, scene.segments) }))
    .filter(({ relationshipId, validation }) => {
      const route = scene.logicalRoutes.find((item) => item.relationshipId === relationshipId)!;
      return route.resolution === "complete" &&
        (!validation.continuous || validation.repeatedSegments.length > 0 || validation.backtracks.length > 0);
    });
  const vias = scene.junctions.filter((junction) => junction.kind === "via");
  const viaCountByRegion = vias.reduce<Record<string, number>>((counts, via) => {
    const region = via.region ?? "undeclared";
    counts[region] = (counts[region] ?? 0) + 1;
    return counts;
  }, {});
  const undeclaredViaIds = vias
    .filter((via) => !via.region || !via.crossingPairIds || via.crossingPairIds.length !== 2)
    .map((via) => via.id);
  const prohibitedViaIds = vias.filter((via) => {
    const inCard = scene.nodes.some((node) => pointInside(node.bounds, via.point));
    const inLabel = scene.segments.some((segment) => pointInside(segment.labelBounds, via.point));
    const inPortCluster = scene.nodes.some((node) => node.ports.some((port) => Math.hypot(port.center.x - via.point.x, port.center.y - via.point.y) < 9));
    const inStorageCorridor = scene.primaryStorageCorridors.some((corridor) => pointInside(corridor.bounds, via.point));
    return inCard || inLabel || inPortCluster || inStorageCorridor;
  }).map((via) => via.id);
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
    requiresAPlusGates ? routeValidationFailures : [],
    requiresAPlusGates && vias.length > 6 ? vias.map((via) => via.id) : [],
    requiresAPlusGates && Object.values(viaCountByRegion).some((count) => count > 2) ? Object.keys(viaCountByRegion) : [],
    requiresAPlusGates ? undeclaredViaIds : [],
    requiresAPlusGates ? prohibitedViaIds : [],
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
    routeValidationFailures,
    viaCount: vias.length,
    viaCountByRegion,
    undeclaredViaIds,
    prohibitedViaIds,
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

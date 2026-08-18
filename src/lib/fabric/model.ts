import { formatBytes, formatCapacityPair, formatRate } from "@/lib/format/bytes";
import {
  accountingForContainers,
  groupWorkloads,
  type FabricAccountingAggregate,
  type FabricAccountingCoverage,
  type FabricAccountingRollup,
  type FabricWorkloadGroup,
} from "@/lib/fabric/groups";
import { boundsFor, type FabricBounds } from "@/lib/fabric/layout";
import {
  materializePort,
  portMap,
  type FabricPort,
  type FabricPortKind,
  type FabricPortSide,
} from "@/lib/fabric/ports";
import {
  routeSceneBetweenPorts,
  type FabricLane,
  type FabricObstacle,
  type FabricRoute,
} from "@/lib/fabric/routing";
import { buildSceneModel, type BodyStatus, type ServiceId } from "@/lib/scene/model";
import { primaryRate, type FlowEndpoint, type FlowObservation } from "@/lib/topology/activity";
import type {
  DashboardSnapshot,
  DockerContainerTelemetry,
  FabricDeclaredRelationship,
  TelemetryStatus,
} from "@/lib/types";

export type FabricPlane = "data" | "control" | "resource" | "state";
export type FabricEvidence = "measured" | "reported" | "derived" | "correlated" | "state-only";
export type FabricFreshness = "live" | "stale" | "unknown" | "not-configured";
export type FabricCoverage = "complete" | "partial" | "unknown";
export type FabricNodeStatus = "healthy" | "degraded" | "unavailable" | "stale" | "not-configured" | "unknown";

export interface FabricMetric {
  label: string;
  value: string;
}

export interface FabricNode {
  id: string;
  kind: "fabric" | "resource" | "workload" | "storage" | "group";
  label: string;
  eyebrow: string;
  status: FabricNodeStatus;
  bounds: FabricBounds;
  metrics: FabricMetric[];
  detail?: string;
}

export interface FabricAttachment {
  id: string;
  nodeId: string;
  fabricId: string;
  kind: "network" | "control" | "read" | "write";
  known: boolean;
  label: string;
  route: FabricRoute;
}

export type FabricNetworkBoundary =
  | "wan"
  | "lan"
  | "overlay"
  | "docker-internal"
  | "host-local"
  | "unknown";

export interface FabricStableCapability {
  nodeId: string;
  network: boolean;
  control: boolean;
  read: boolean;
  write: boolean;
  networkSegmentIds: string[];
  coverage: Record<"network" | "control" | "read" | "write", FabricCoverage>;
}

export interface FabricRelationship {
  id: string;
  label: string;
  plane: "data" | "control";
  evidence: FabricEvidence;
  freshness: FabricFreshness;
  coverage: FabricCoverage;
  fromNodeId: string;
  toNodeId: string;
  fromPortId: string;
  toPortId: string;
  rateBytesPerSecond: number | null;
  width: number;
  direction: "forward" | "reverse" | "bidirectional";
  tone: "in" | "out" | "mixed";
  animated: boolean;
  visibility: "active" | "focus";
  provenance: string;
  basis: string | null;
  attribution: string | null;
  networkBoundary: FabricNetworkBoundary;
  route: FabricRoute;
}

export interface FabricResourceView {
  id: "cpu" | "memory" | "gpu" | "arc";
  nodeId: string;
  status: FabricFreshness;
  fraction: number | null;
  segments: number[];
  primary: string;
  secondary: string | null;
  accountedValue?: number | null;
  accountedFraction?: number | null;
  accountedCoverage?: FabricAccountingCoverage;
  contributors?: FabricResourceContribution[];
}

export interface FabricAccountedNode {
  nodeId: string;
  label: string;
  kind: "workload" | "group";
  containerIds: string[];
  accounting: FabricAccountingRollup;
}

export interface FabricResourceContribution {
  nodeId: string;
  label: string;
  kind: FabricAccountedNode["kind"];
  containerIds: string[];
  value: number | null;
  fraction: number | null;
  coverage: FabricAccountingCoverage;
  completeContributors: number;
  partialContributors: number;
  unknownContributors: number;
}

export interface FabricPopulation {
  total: number | null;
  represented: number;
  running: number | null;
  groups: FabricWorkloadGroup[];
  ids: string[];
  accountedNodes: FabricAccountedNode[];
}

export interface FabricTrunk {
  id: string;
  label: string;
  eyebrow: string;
  bounds: FabricBounds;
  kind: "control" | "read" | "write";
}

export interface FabricModel {
  regions: Array<{ id: string; label: string; bounds: FabricBounds }>;
  trunks: FabricTrunk[];
  nodes: FabricNode[];
  ports: FabricPort[];
  attachments: FabricAttachment[];
  relationships: FabricRelationship[];
  resourceViews: FabricResourceView[];
  stableCapabilities: FabricStableCapability[];
  population: FabricPopulation;
  routing: { obstacles: FabricObstacle[]; lanes: FabricLane[] };
}

export interface FabricModelOptions {
  now: number;
  seerrConfigured: boolean;
  /** Configured/declared external modules. Unknown activity never adds one. */
  networkBoundaries?: readonly Extract<FabricNetworkBoundary, "wan" | "lan" | "overlay">[];
  /** Presentation-only normalization for observations whose boundary is known upstream. */
  networkBoundaryByFlowId?: Readonly<Record<string, FabricNetworkBoundary>>;
}

const SERVICE_ORDER: ServiceId[] = ["jellyfin", "qbittorrent", "sonarr", "radarr", "seerr"];

const STABLE_SERVICE_CAPABILITIES: Record<ServiceId, Omit<FabricStableCapability, "nodeId" | "networkSegmentIds">> = {
  jellyfin: {
    network: true,
    control: false,
    read: true,
    write: false,
    coverage: { network: "complete", control: "unknown", read: "complete", write: "complete" },
  },
  qbittorrent: {
    network: true,
    control: false,
    read: true,
    write: true,
    coverage: { network: "complete", control: "unknown", read: "complete", write: "complete" },
  },
  sonarr: {
    network: true,
    control: true,
    read: true,
    write: true,
    coverage: { network: "complete", control: "complete", read: "complete", write: "complete" },
  },
  radarr: {
    network: true,
    control: true,
    read: true,
    write: true,
    coverage: { network: "complete", control: "complete", read: "complete", write: "complete" },
  },
  seerr: {
    network: true,
    control: true,
    read: false,
    write: false,
    coverage: { network: "complete", control: "complete", read: "complete", write: "complete" },
  },
};

const statusFromBody = (status: BodyStatus): FabricNodeStatus => {
  if (status === "ok") return "healthy";
  if (status === "degraded") return "degraded";
  if (status === "down") return "unavailable";
  if (status === "not-configured") return "not-configured";
  return "unknown";
};

const freshness = (status: TelemetryStatus): FabricFreshness =>
  status === "available" ? "live" : status === "stale" ? "stale" : status === "not-configured" ? "not-configured" : "unknown";

const pct = (fraction: number | null): string =>
  fraction === null ? "—" : `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;

const portId = (nodeId: string, kind: FabricPortKind) => `${nodeId}:${kind}`;

const accountedContainerId = (container: Pick<DockerContainerTelemetry, "stableId" | "name">) =>
  container.stableId ?? `name-${container.name}`;

function flowWidth(rate: number | null, plane: "data" | "control"): number {
  if (plane === "control") return 1;
  if (rate === null || rate <= 0) return 1.5;
  const floor = 64_000;
  const ceiling = 250_000_000;
  const t = (Math.log10(Math.max(floor, rate)) - Math.log10(floor)) /
    (Math.log10(ceiling) - Math.log10(floor));
  return Number((1.8 + Math.max(0, Math.min(1, t)) * 5.2).toFixed(2));
}

function endpointNode(endpoint: FlowEndpoint, _other: FlowEndpoint): string {
  if (endpoint.kind === "network") return "fabric:gateway";
  if (endpoint.kind === "service") return `service:${endpoint.id}`;
  if (endpoint.kind === "pool") return `pool:${endpoint.name}`;
  return "pool:unmapped";
}

function flowPortKind(flow: FlowObservation, endpoint: "from" | "to"): FabricPortKind {
  if (flow.plane === "control") return "control";
  const roles = flow.channels.map((channel) => channel.role);
  if (flow.kind === "wan-transfer" || flow.kind === "egress") return "network";
  if (roles.includes("read") && !roles.includes("write")) return "read";
  if (roles.includes("write")) return endpoint === "from" && flow.kind === "import-copy" ? "read" : "write";
  return "network";
}

function declaredNode(value: string): string | null {
  if (value.startsWith("service:")) return value;
  if (value.startsWith("pool:")) return value;
  if (value === "host:control") return "fabric:service";
  return null;
}

function declaredNodeLabel(nodeId: string): string {
  if (nodeId === "fabric:service") return "host control";
  const separator = nodeId.indexOf(":");
  return separator === -1 ? nodeId : nodeId.slice(separator + 1);
}

function declaredPortId(nodeId: string): string {
  return portId(nodeId, "control");
}

function directionOf(flow: FlowObservation): FabricRelationship["direction"] {
  const directions = new Set(flow.channels.map((channel) => channel.direction));
  return directions.size > 1 ? "bidirectional" : directions.has("reverse") ? "reverse" : "forward";
}

function toneOf(flow: FlowObservation): FabricRelationship["tone"] {
  if (flow.channels.some((channel) => channel.direction === "forward") && flow.channels.some((channel) => channel.direction === "reverse")) return "mixed";
  if (flow.kind === "egress" || flow.channels.every((channel) => channel.direction === "reverse")) return "out";
  return "in";
}

function networkBoundaryOf(
  flow: FlowObservation,
  overrides: FabricModelOptions["networkBoundaryByFlowId"],
): FabricNetworkBoundary {
  const declared = overrides?.[flow.id];
  if (declared) return declared;
  if (flow.kind === "wan-transfer") return "wan";
  if (flow.from.kind === "network" || flow.to.kind === "network") return "unknown";
  if (flow.plane === "control" && flow.from.kind === "service" && flow.to.kind === "service") {
    return "docker-internal";
  }
  return "host-local";
}

interface FabricRouteContext {
  obstacles: FabricObstacle[];
  lanes: FabricLane[];
  priorRoutes: FabricRoute[];
}

function allowedLanes(kind: FabricPortKind): string[] {
  if (kind === "network") return ["lane:network-trunk"];
  if (kind === "control") return ["lane:control-trunk"];
  if (kind === "read") return ["lane:storage-read"];
  if (kind === "write") return ["lane:storage-write"];
  return [];
}

function routeInContext(
  fromPort: FabricPort,
  toPort: FabricPort,
  context: FabricRouteContext,
  ownerId: string,
  endpointNodeIds: string[],
): FabricRoute {
  const route = routeSceneBetweenPorts({
    from: fromPort,
    to: toPort,
    obstacles: context.obstacles.filter((obstacle) => !endpointNodeIds.includes(obstacle.id)),
    lanes: context.lanes,
    priorRoutes: context.priorRoutes,
    ownerId,
    allowSharedLaneIds: allowedLanes(fromPort.kind),
  });
  context.priorRoutes.push(route);
  return route;
}

function expectedServiceNames(id: ServiceId): string[] {
  return id === "seerr" ? ["seerr", "jellyseerr"] : [id];
}

function findServiceContainer(
  snapshot: DashboardSnapshot,
  containers: DockerContainerTelemetry[],
  id: ServiceId,
): DockerContainerTelemetry | null {
  const configuredJellyfin = id === "jellyfin" ? snapshot.jellyfinContainer?.toLowerCase() : null;
  const expectedNames = expectedServiceNames(id);
  return containers.find((container) => {
    const name = container.name.toLowerCase();
    const composeService = container.composeService?.toLowerCase();
    return (configuredJellyfin !== null && name === configuredJellyfin) ||
      expectedNames.includes(composeService ?? "") ||
      expectedNames.includes(name);
  }) ?? null;
}

function accountedNodeFromContainers(
  nodeId: string,
  label: string,
  kind: FabricAccountedNode["kind"],
  containers: DockerContainerTelemetry[],
): FabricAccountedNode {
  return {
    nodeId,
    label,
    kind,
    containerIds: containers.map(accountedContainerId),
    accounting: accountingForContainers(containers),
  };
}

function resourceContribution(
  accountedNode: FabricAccountedNode,
  aggregate: FabricAccountingAggregate,
  denominator: number | null,
): FabricResourceContribution {
  return {
    nodeId: accountedNode.nodeId,
    label: accountedNode.label,
    kind: accountedNode.kind,
    containerIds: accountedNode.containerIds,
    value: aggregate.value,
    fraction: aggregate.value !== null && denominator !== null && denominator > 0
      ? aggregate.value / denominator
      : null,
    coverage: aggregate.coverage,
    completeContributors: aggregate.completeContributors,
    partialContributors: aggregate.partialContributors,
    unknownContributors: aggregate.unknownContributors,
  };
}

function summarizeCoverage(aggregates: FabricAccountingAggregate[]): FabricAccountingCoverage {
  const known = aggregates.filter((aggregate) => aggregate.coverage !== "unknown");
  if (known.length === 0) return "unknown";
  return known.every((aggregate) => aggregate.coverage === "complete") ? "complete" : "partial";
}

function knownAggregateValue(aggregates: FabricAccountingAggregate[]): number | null {
  const values = aggregates
    .map((aggregate) => aggregate.value)
    .filter((value): value is number => typeof value === "number");
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null;
}

function relationshipFromFlow(
  flow: FlowObservation,
  ports: Map<string, FabricPort>,
  context: FabricRouteContext,
  networkBoundary: FabricNetworkBoundary,
): FabricRelationship | null {
  const fromNodeId = endpointNode(flow.from, flow.to);
  const toNodeId = endpointNode(flow.to, flow.from);
  const fromPortId = portId(fromNodeId, flowPortKind(flow, "from"));
  const toPortId = portId(toNodeId, flowPortKind(flow, "to"));
  const fromPort = ports.get(fromPortId);
  const toPort = ports.get(toPortId);
  if (!fromPort || !toPort) return null;
  const rate = primaryRate(flow);
  const coverage: FabricCoverage = flow.rate?.coverage ??
    (flow.channels.some((channel) => channel.bytesPerSecond === null) ? "unknown" : "complete");
  const basis = flow.rate?.basis ?? null;
  return {
    id: flow.id,
    label: flow.label,
    plane: flow.plane,
    evidence: flow.evidence,
    freshness: flow.freshness,
    coverage,
    fromNodeId,
    toNodeId,
    fromPortId,
    toPortId,
    rateBytesPerSecond: rate,
    width: flowWidth(rate, flow.plane),
    direction: directionOf(flow),
    tone: toneOf(flow),
    animated: flow.plane === "data" && flow.freshness === "live" && rate !== null && rate > 0,
    visibility: "active",
    provenance: flow.provenance,
    basis,
    attribution: flow.evidence === "derived" ? "Path or rate includes declared or correlated attribution." : null,
    networkBoundary,
    route: routeInContext(fromPort, toPort, context, `relationship:${flowPortKind(flow, "from")}`, [fromNodeId, toNodeId]),
  };
}

function gatewayBoundaryRelationship(
  flow: FlowObservation,
  ports: Map<string, FabricPort>,
  context: FabricRouteContext,
  networkBoundary: FabricNetworkBoundary,
): FabricRelationship | null {
  if (flow.from.kind !== "network" && flow.to.kind !== "network") return null;
  if (networkBoundary !== "wan" && networkBoundary !== "lan" && networkBoundary !== "overlay") return null;
  const fromPort = ports.get(`external:${networkBoundary}:network`);
  const toPort = ports.get(`fabric:gateway:${networkBoundary}-network`);
  if (!fromPort || !toPort) return null;
  const rate = primaryRate(flow);
  return {
    id: `${flow.id}:gateway-boundary:${networkBoundary}`,
    label: `${networkBoundary === "overlay" ? "Overlay" : networkBoundary.toUpperCase()} ↔ host gateway`,
    plane: "data",
    evidence: flow.evidence,
    freshness: flow.freshness,
    coverage: flow.rate?.coverage ?? (flow.channels.some((channel) => channel.bytesPerSecond === null) ? "unknown" : "complete"),
    fromNodeId: `external:${networkBoundary}`,
    toNodeId: "fabric:gateway",
    fromPortId: fromPort.id,
    toPortId: toPort.id,
    rateBytesPerSecond: rate,
    width: flowWidth(rate, "data"),
    direction: directionOf(flow),
    tone: toneOf(flow),
    animated: flow.freshness === "live" && rate !== null && rate > 0,
    visibility: "active",
    provenance: flow.provenance,
    basis: flow.rate?.basis ?? null,
    attribution: "Observed external traffic terminates at the host gateway; Docker membership is modeled separately.",
    networkBoundary,
    route: routeInContext(fromPort, toPort, context, "relationship:network", [`external:${networkBoundary}`, "fabric:gateway"]),
  };
}

function relationshipFromDeclaration(
  declaration: FabricDeclaredRelationship,
  ports: Map<string, FabricPort>,
  index: number,
  context: FabricRouteContext,
): FabricRelationship | null {
  const fromNodeId = declaredNode(declaration.from);
  const toNodeId = declaredNode(declaration.to);
  if (!fromNodeId || !toNodeId) return null;
  const fromPortId = declaredPortId(fromNodeId);
  const toPortId = declaredPortId(toNodeId);
  const fromPort = ports.get(fromPortId);
  const toPort = ports.get(toPortId);
  if (!fromPort || !toPort) return null;
  return {
    id: `declared:${index}:${fromNodeId}->${toNodeId}`,
    label: declaration.label ?? `${declaredNodeLabel(fromNodeId)} → ${declaredNodeLabel(toNodeId)}`,
    plane: "control",
    evidence: "reported",
    freshness: "live",
    coverage: "complete",
    fromNodeId,
    toNodeId,
    fromPortId,
    toPortId,
    rateBytesPerSecond: null,
    width: 1,
    direction: "forward",
    tone: "in",
    animated: false,
    visibility: "focus",
    provenance: "operator-declared topology configuration",
    basis: declaration.kind === "control" ? "declared control" : "declared dependency",
    attribution: "Declared relationship; not observed byte throughput.",
    networkBoundary: fromNodeId.startsWith("service:") && toNodeId.startsWith("service:")
      ? "docker-internal"
      : "host-local",
    route: routeInContext(fromPort, toPort, context, "relationship:control", [fromNodeId, toNodeId]),
  };
}

export function buildFabricModel(snapshot: DashboardSnapshot, options: FabricModelOptions): FabricModel {
  const scene = buildSceneModel(snapshot, options);
  const nodes: FabricNode[] = [];
  const trunks: FabricTrunk[] = [];
  const ports: FabricPort[] = [];
  const accountedNodes: FabricAccountedNode[] = [];
  const pendingAttachments: Array<Omit<FabricAttachment, "route"> & { from: FabricPort; to: FabricPort }> = [];

  const addNode = (node: FabricNode) => nodes.push(node);
  const addPort = (nodeId: string, bounds: FabricBounds, kind: FabricPortKind, side: FabricPortSide, offset: number, label: string) => {
    const port = materializePort({ id: portId(nodeId, kind), nodeId, kind, side, offset, label }, bounds);
    ports.push(port);
    return port;
  };
  const addCustomPort = (id: string, nodeId: string, bounds: FabricBounds, kind: FabricPortKind, side: FabricPortSide, offset: number, label: string) => {
    const port = materializePort({ id, nodeId, kind, side, offset, label }, bounds);
    ports.push(port);
    return port;
  };

  const dockerContainers = snapshot.telemetry.docker.value?.containers ?? [];
  const serviceContainers = new Map<ServiceId, DockerContainerTelemetry | null>(
    SERVICE_ORDER.map((id) => [id, findServiceContainer(snapshot, dockerContainers, id)]),
  );
  const serviceKinds = new Map<ServiceId, Set<FabricPortKind>>(
    SERVICE_ORDER.map((id) => [id, new Set<FabricPortKind>()]),
  );
  for (const id of SERVICE_ORDER) {
    if ((serviceContainers.get(id)?.networkNames?.length ?? 0) > 0) serviceKinds.get(id)!.add("network");
  }
  for (const flow of scene.flows) {
    if (flow.from.kind === "service") serviceKinds.get(flow.from.id)?.add(flowPortKind(flow, "from"));
    if (flow.to.kind === "service") serviceKinds.get(flow.to.id)?.add(flowPortKind(flow, "to"));
  }
  for (const declaration of snapshot.fabricRelationships ?? []) {
    for (const endpoint of [declaration.from, declaration.to]) {
      if (!endpoint.startsWith("service:")) continue;
      const id = endpoint.slice("service:".length) as ServiceId;
      serviceKinds.get(id)?.add("control");
    }
  }

  const wanBounds = boundsFor("external-wan");
  const lanBounds = boundsFor("external-lan");
  const overlayBounds = boundsFor("external-overlay");
  const gatewayBounds = boundsFor("host-gateway");
  const controlBounds = boundsFor("control-lane");
  const readBounds = boundsFor("storage-read-fabric");
  const writeBounds = boundsFor("storage-write-fabric");

  const configuredNetworkBoundaries = new Set<Extract<FabricNetworkBoundary, "wan" | "lan" | "overlay">>(
    options.networkBoundaries ?? ["wan"],
  );
  for (const boundary of Object.values(options.networkBoundaryByFlowId ?? {})) {
    if (boundary === "wan" || boundary === "lan" || boundary === "overlay") configuredNetworkBoundaries.add(boundary);
  }

  const boundaryBounds = { wan: wanBounds, lan: lanBounds, overlay: overlayBounds } as const;
  const boundaryLabels = { wan: "WAN", lan: "LAN", overlay: "TAILSCALE" } as const;
  for (const boundary of ["wan", "lan", "overlay"] as const) {
    if (!configuredNetworkBoundaries.has(boundary)) continue;
    addNode({
      id: `external:${boundary}`,
      kind: "fabric",
      label: boundaryLabels[boundary],
      eyebrow: "EXTERNAL BOUNDARY",
      status: boundary === "wan" && snapshot.telemetry.network.status === "available" ? "healthy" : "unknown",
      bounds: boundaryBounds[boundary],
      metrics: [],
    });
  }
  addNode({ id: "fabric:gateway", kind: "fabric", label: "HOST GATEWAY", eyebrow: "OBSERVED PATHS ONLY", status: snapshot.telemetry.network.status === "available" ? "healthy" : snapshot.telemetry.network.status, bounds: gatewayBounds, metrics: [] });
  trunks.push(
    { id: "fabric:service", label: "CONTROL RELATIONSHIPS", eyebrow: "FOCUS / MAP ONLY", bounds: controlBounds, kind: "control" },
    { id: "fabric:storage-read", label: "READ SUBSTRATE", eyebrow: "OBSERVED / DECLARED", bounds: readBounds, kind: "read" },
    { id: "fabric:storage-write", label: "WRITE SUBSTRATE", eyebrow: "OBSERVED / DECLARED", bounds: writeBounds, kind: "write" },
  );

  for (const boundary of ["wan", "lan", "overlay"] as const) {
    if (!configuredNetworkBoundaries.has(boundary)) continue;
    addCustomPort(`external:${boundary}:network`, `external:${boundary}`, boundaryBounds[boundary], "network", "right", 0.5, `${boundaryLabels[boundary]} boundary`);
    addCustomPort(`fabric:gateway:${boundary}-network`, "fabric:gateway", gatewayBounds, "network", "left", boundary === "wan" ? 0.22 : boundary === "lan" ? 0.5 : 0.78, `${boundaryLabels[boundary]} gateway path`);
  }
  addPort("fabric:gateway", gatewayBounds, "network", "right", 0.72, "Host network path");
  addCustomPort("fabric:service:control", "fabric:service", controlBounds, "control", "top", (566 - controlBounds.x) / controlBounds.width, "Host control");

  const membershipCounts = new Map<string, number>();
  for (const container of dockerContainers) {
    for (const name of container.networkNames ?? []) membershipCounts.set(name, (membershipCounts.get(name) ?? 0) + 1);
  }
  const orderedNetworkNames = [...membershipCounts.keys()].sort();
  const shownNetworkNames = orderedNetworkNames.slice(0, 2);
  const aggregatedNetworkNames = orderedNetworkNames.slice(2);
  const networkSegments: Array<{ id: string; names: string[]; label: string; count: number; bounds: FabricBounds }> = shownNetworkNames.map((name, index) => ({
    id: `network:${name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`,
    names: [name],
    label: name,
    count: membershipCounts.get(name) ?? 0,
    bounds: boundsFor("network-segment", index),
  }));
  if (aggregatedNetworkNames.length) {
    networkSegments.push({
      id: "network:other-docker-segments",
      names: aggregatedNetworkNames,
      label: `${aggregatedNetworkNames.length} OTHER SEGMENTS`,
      count: aggregatedNetworkNames.reduce((sum, name) => sum + (membershipCounts.get(name) ?? 0), 0),
      bounds: boundsFor("network-segment", 2),
    });
  }
  const networkSegmentByName = new Map<string, typeof networkSegments[number]>();
  for (const segment of networkSegments) {
    for (const name of segment.names) networkSegmentByName.set(name, segment);
    addNode({
      id: segment.id,
      kind: "fabric",
      label: segment.label,
      eyebrow: segment.names.length === 1 ? `DOCKER NETWORK · ${segment.count} MEMBERS` : `AGGREGATED DOCKER NETWORKS · ${segment.count} MEMBERS`,
      status: snapshot.telemetry.docker.status === "available" ? "healthy" : snapshot.telemetry.docker.status,
      bounds: segment.bounds,
      metrics: [],
      detail: segment.names.join(" · "),
    });
    addPort(segment.id, segment.bounds, "network", "right", 0.5, segment.names.length === 1 ? segment.label : segment.names.join(" · "));
  }

  const cpuBounds = boundsFor("cpu");
  const memoryBounds = boundsFor("memory");
  const gpuBounds = boundsFor("gpu");
  const arcBounds = boundsFor("arc");
  const gpu = snapshot.telemetry.gpu.value;
  const memory = snapshot.telemetry.memory.value;
  const arc = snapshot.telemetry.arc.value;
  addNode({ id: "resource:cpu", kind: "resource", label: scene.core.hostname, eyebrow: "CPU PACKAGE", status: scene.core.status === "available" ? "healthy" : scene.core.status, bounds: cpuBounds, metrics: [{ label: "used", value: pct(scene.core.totalFraction) }, { label: "load", value: scene.core.load1?.toFixed(2) ?? "—" }] });
  addNode({ id: "resource:memory", kind: "resource", label: "Memory", eyebrow: "ACCOUNTING", status: snapshot.telemetry.memory.status === "available" ? "healthy" : snapshot.telemetry.memory.status, bounds: memoryBounds, metrics: [{ label: "charged", value: memory ? formatCapacityPair(memory.usedBytes, memory.totalBytes) : "—" }] });
  addNode({ id: "resource:gpu", kind: "resource", label: gpu?.name ?? "GPU", eyebrow: "ENGINE + VRAM", status: snapshot.telemetry.gpu.status === "available" ? "healthy" : snapshot.telemetry.gpu.status, bounds: gpuBounds, metrics: [{ label: "engine", value: pct(gpu?.utilizationFraction ?? null) }, { label: "VRAM", value: gpu ? formatCapacityPair(gpu.vramUsedBytes, gpu.vramTotalBytes) : "—" }] });
  addNode({ id: "resource:arc", kind: "resource", label: "ZFS ARC", eyebrow: "CACHE OCCUPANCY", status: snapshot.telemetry.arc.status === "available" ? "healthy" : snapshot.telemetry.arc.status, bounds: arcBounds, metrics: [{ label: "resident", value: arc ? formatBytes(arc.sizeBytes) : "—" }, { label: "hit", value: arc?.hitRatio === null || arc?.hitRatio === undefined ? "—" : pct(arc.hitRatio) }] });

  const serviceById = new Map(scene.services.map((service) => [service.id, service]));
  for (const [index, id] of SERVICE_ORDER.entries()) {
    const service = serviceById.get(id)!;
    const bounds = boundsFor("service", index);
    const nodeId = `service:${id}`;
    const matchingContainer = serviceContainers.get(id) ?? null;
    const accounting = accountingForContainers(matchingContainer ? [matchingContainer] : []);
    const cpuMetric = accounting.cpuCores.value === null ? "—" : `${accounting.cpuCores.coverage === "partial" ? "≈" : ""}${accounting.cpuCores.value.toFixed(2)}c`;
    const memoryMetric = accounting.memoryBytes.value === null ? "—" : `${accounting.memoryBytes.coverage === "partial" ? "≈" : ""}${formatBytes(accounting.memoryBytes.value)}`;
    const activeEyebrow = service.active && service.count !== null ? `${service.count} ${(service.detail ?? "ACTIVE").toUpperCase()}` : "SERVICE";
    addNode({ id: nodeId, kind: "workload", label: service.label, eyebrow: activeEyebrow, status: statusFromBody(service.status), bounds, metrics: [{ label: "CPU", value: cpuMetric }, { label: "MEM", value: memoryMetric }] });
    const nodePorts = new Map<FabricPortKind, FabricPort>();
    for (const kind of serviceKinds.get(id) ?? []) {
      const port = kind === "network" ? addPort(nodeId, bounds, kind, "left", 0.5, "Docker network")
        : kind === "control" ? addPort(nodeId, bounds, kind, "bottom", 0.2, "Control")
          : kind === "read" ? addPort(nodeId, bounds, kind, "bottom", 0.55, "Read")
            : addPort(nodeId, bounds, kind, "bottom", 0.82, "Write");
      nodePorts.set(kind, port);
    }
    const networkNames = matchingContainer?.networkNames ?? [];
    const segment = networkNames.map((name) => networkSegmentByName.get(name)).find(Boolean);
    const segmentPort = segment ? ports.find((port) => port.id === portId(segment.id, "network")) : null;
    const networkPort = nodePorts.get("network");
    if (segment && segmentPort && networkPort) {
      pendingAttachments.push({ id: `attach:network:${id}`, nodeId, fabricId: segment.id, kind: "network", known: true, label: networkNames.join(" · "), from: segmentPort, to: networkPort });
    }
    accountedNodes.push(accountedNodeFromContainers(nodeId, service.label, "workload", matchingContainer ? [matchingContainer] : []));
  }

  const pools = [...scene.storage];
  if (scene.genericStorageTarget) {
    pools.push({
      name: "unmapped", capacityFraction: 0, capacityTone: "ok", rank: pools.length,
      healthy: true, healthLabel: "UNMAPPED", scrubbing: false, lastScrubAt: null,
      scrubErrors: 0, readBps: null, writeBps: null, ioFreshness: "unavailable",
      capacityLabelBytes: { used: 0, total: 0 }, capacityBasis: "logical",
    });
  }
  pools.slice(0, 3).forEach((pool, index) => {
    const bounds = boundsFor("pool", index);
    const nodeId = `pool:${pool.name}`;
    addNode({ id: nodeId, kind: "storage", label: pool.name === "unmapped" ? "Storage endpoint" : pool.name, eyebrow: pool.name === "unmapped" ? "POOL NOT DECLARED" : `${pool.healthLabel}${pool.scrubbing ? " · ACTIVE SCAN" : ""}`, status: pool.name === "unmapped" ? "unknown" : pool.healthy ? (pool.ioFreshness === "stale" ? "stale" : "healthy") : "degraded", bounds, metrics: pool.name === "unmapped" ? [{ label: "identity", value: "unknown" }] : [{ label: "capacity", value: formatCapacityPair(pool.capacityLabelBytes.used, pool.capacityLabelBytes.total) }, { label: "used", value: pct(pool.capacityFraction) }] });
    const read = addPort(nodeId, bounds, "read", "top", 0.34, "Read");
    const write = addPort(nodeId, bounds, "write", "top", 0.7, "Write");
    if ((snapshot.fabricRelationships ?? []).some((declaration) => declaration.from === nodeId || declaration.to === nodeId)) {
      addPort(nodeId, bounds, "control", "top", 0.52, "Declared control");
    }
    const readFabric = addCustomPort(`fabric:storage-read:${pool.name}:read`, "fabric:storage-read", readBounds, "read", "bottom", (read.center.x - readBounds.x) / readBounds.width, `${pool.name} read attachment`);
    const writeFabric = addCustomPort(`fabric:storage-write:${pool.name}:write`, "fabric:storage-write", writeBounds, "write", "bottom", (write.center.x - writeBounds.x) / writeBounds.width, `${pool.name} write attachment`);
    pendingAttachments.push({ id: `attach:read:${pool.name}`, nodeId, fabricId: "fabric:storage-read", kind: "read", known: pool.name !== "unmapped", label: `${pool.name} read substrate`, from: readFabric, to: read });
    pendingAttachments.push({ id: `attach:write:${pool.name}`, nodeId, fabricId: "fabric:storage-write", kind: "write", known: pool.name !== "unmapped", label: `${pool.name} write substrate`, from: writeFabric, to: write });
  });

  const groups = groupWorkloads(dockerContainers);
  groups.forEach((group, index) => {
    const bounds = boundsFor("group", index);
    const status: FabricNodeStatus = group.attentionCount > 0 ? "degraded" : snapshot.telemetry.docker.status === "available" ? "healthy" : snapshot.telemetry.docker.status;
    const cpu = group.accounting.cpuCores;
    const memoryAccounting = group.accounting.memoryBytes;
    const io = group.accounting.ioBytesPerSecond;
    addNode({
      id: group.id,
      kind: "group",
      label: group.label,
      eyebrow: `${group.members.length} WORKLOAD${group.members.length === 1 ? "" : "S"}${group.attentionCount ? ` · ${group.attentionCount} ATTENTION` : ""}`,
      status,
      bounds,
      metrics: [
        { label: "CPU", value: cpu.value === null ? "—" : `${cpu.coverage === "partial" ? "≈" : ""}${cpu.value.toFixed(2)}c` },
        { label: "MEM", value: memoryAccounting.value === null ? "—" : `${memoryAccounting.coverage === "partial" ? "≈" : ""}${formatBytes(memoryAccounting.value)}` },
        { label: "I/O", value: io.value === null ? "—" : `${io.coverage === "partial" ? "≈" : ""}${formatRate(io.value)}` },
      ],
    });
    const names = [...new Set(group.members.flatMap((member) => member.networkNames ?? []))].sort();
    const segment = names.map((name) => networkSegmentByName.get(name)).find(Boolean);
    const segmentPort = segment ? ports.find((port) => port.id === portId(segment.id, "network")) : null;
    if (segment && segmentPort) {
      const network = addPort(group.id, bounds, "network", "left", 0.5, "Docker network membership");
      pendingAttachments.push({ id: `attach:network:${group.id}`, nodeId: group.id, fabricId: segment.id, kind: "network", known: true, label: names.join(" · "), from: segmentPort, to: network });
    }
    accountedNodes.push({
      nodeId: group.id,
      label: group.label,
      kind: "group",
      containerIds: group.members.map((member) => member.id),
      accounting: group.accounting,
    });
  });

  const obstacles: FabricObstacle[] = [
    ...nodes.flatMap((node) => [
      { id: node.id, bounds: node.bounds, padding: 14 },
      { id: node.id, bounds: { x: node.bounds.x + 8, y: node.bounds.y + 8, width: Math.max(1, node.bounds.width - 16), height: Math.min(58, Math.max(1, node.bounds.height - 16)) }, padding: 4 },
    ]),
    { id: "text:hardware", bounds: { x: 28, y: 28, width: 92, height: 16 }, padding: 4 },
    { id: "text:network", bounds: { x: 28, y: 162, width: 112, height: 16 }, padding: 4 },
    { id: "text:workloads", bounds: { x: 208, y: 162, width: 112, height: 16 }, padding: 4 },
    { id: "text:storage", bounds: { x: 208, y: 462, width: 92, height: 16 }, padding: 4 },
  ];
  const lanes: FabricLane[] = [
    { id: "lane:external-gateway", axis: "vertical", coordinate: 176, start: 198, end: 330, ownerId: "relationship:network", shared: true },
    { id: "lane:network-trunk", axis: "vertical", coordinate: 190, start: 170, end: 434, ownerId: "relationship:network", shared: true },
    { id: "lane:control-trunk", axis: "horizontal", coordinate: 452, start: 190, end: 934, ownerId: "relationship:control", shared: true },
    { id: "lane:storage-read", axis: "horizontal", coordinate: 484, start: 190, end: 934, ownerId: "relationship:read", shared: true },
    { id: "lane:storage-write", axis: "horizontal", coordinate: 508, start: 190, end: 934, ownerId: "relationship:write", shared: true },
  ];
  const attachmentContext: FabricRouteContext = { obstacles, lanes, priorRoutes: [] };
  const attachments: FabricAttachment[] = pendingAttachments.map(({ from, to, ...attachment }) => ({
    ...attachment,
    route: routeInContext(from, to, attachmentContext, `attachment:${attachment.kind}`, [attachment.nodeId, attachment.fabricId]),
  }));

  const byPort = portMap(ports);
  const relationshipContext: FabricRouteContext = { obstacles, lanes, priorRoutes: [] };
  const relationships = scene.flows.flatMap((flow) => {
    const networkBoundary = networkBoundaryOf(flow, options.networkBoundaryByFlowId);
    const relationship = relationshipFromFlow(flow, byPort, relationshipContext, networkBoundary);
    const boundary = gatewayBoundaryRelationship(flow, byPort, relationshipContext, networkBoundary);
    return [relationship, boundary].filter((item): item is FabricRelationship => item !== null);
  });
  for (const [index, declaration] of (snapshot.fabricRelationships ?? []).entries()) {
    const relationship = relationshipFromDeclaration(declaration, byPort, index, relationshipContext);
    if (relationship && !relationships.some((item) => item.fromNodeId === relationship.fromNodeId && item.toNodeId === relationship.toNodeId && item.plane === "control")) relationships.push(relationship);
  }

  const cpuDenominator = scene.core.perCore.length > 0 ? scene.core.perCore.length : null;
  const memoryDenominator = scene.core.memTotalBytes;
  const cpuContributors = [...accountedNodes]
    .map((accountedNode) => resourceContribution(accountedNode, accountedNode.accounting.cpuCores, cpuDenominator))
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || a.label.localeCompare(b.label));
  const memoryContributors = [...accountedNodes]
    .map((accountedNode) => resourceContribution(accountedNode, accountedNode.accounting.memoryBytes, memoryDenominator))
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || a.label.localeCompare(b.label));
  const accountedCpuValue = knownAggregateValue(accountedNodes.map((node) => node.accounting.cpuCores));
  const accountedMemoryValue = knownAggregateValue(accountedNodes.map((node) => node.accounting.memoryBytes));

  const resourceViews: FabricResourceView[] = [
    {
      id: "cpu",
      nodeId: "resource:cpu",
      status: freshness(snapshot.telemetry.cpu.status),
      fraction: scene.core.totalFraction,
      segments: scene.core.perCore,
      primary: scene.core.totalFraction === null ? "Unknown" : `${(scene.core.totalFraction * scene.core.perCore.length).toFixed(1)} cores used`,
      secondary: `${scene.core.perCore.length} logical CPUs`,
      accountedValue: accountedCpuValue,
      accountedFraction: accountedCpuValue !== null && cpuDenominator !== null && cpuDenominator > 0
        ? accountedCpuValue / cpuDenominator
        : null,
      accountedCoverage: summarizeCoverage(accountedNodes.map((node) => node.accounting.cpuCores)),
      contributors: cpuContributors,
    },
    {
      id: "memory",
      nodeId: "resource:memory",
      status: freshness(snapshot.telemetry.memory.status),
      fraction: scene.core.memFraction,
      segments: scene.core.memFraction === null ? [] : [scene.core.memFraction],
      primary: scene.core.memUsedBytes === null ? "Unknown" : `${formatBytes(scene.core.memUsedBytes)} charged`,
      secondary: scene.core.memTotalBytes === null ? null : `${formatBytes(scene.core.memTotalBytes)} total`,
      accountedValue: accountedMemoryValue,
      accountedFraction: accountedMemoryValue !== null && memoryDenominator !== null && memoryDenominator > 0
        ? accountedMemoryValue / memoryDenominator
        : null,
      accountedCoverage: summarizeCoverage(accountedNodes.map((node) => node.accounting.memoryBytes)),
      contributors: memoryContributors,
    },
    { id: "gpu", nodeId: "resource:gpu", status: freshness(snapshot.telemetry.gpu.status), fraction: gpu?.utilizationFraction ?? null, segments: gpu ? [gpu.utilizationFraction, gpu.vramTotalBytes > 0 ? gpu.vramUsedBytes / gpu.vramTotalBytes : 0] : [], primary: gpu ? `${pct(gpu.utilizationFraction)} engine` : "Not configured", secondary: gpu ? `${formatBytes(gpu.vramUsedBytes)} VRAM` : null },
    { id: "arc", nodeId: "resource:arc", status: freshness(snapshot.telemetry.arc.status), fraction: arc?.targetBytes && arc.targetBytes > 0 ? arc.sizeBytes / arc.targetBytes : null, segments: arc ? [arc.targetBytes && arc.targetBytes > 0 ? arc.sizeBytes / arc.targetBytes : 0] : [], primary: arc ? `${formatBytes(arc.sizeBytes)} resident` : "Unknown", secondary: arc?.hitRatio === null || arc?.hitRatio === undefined ? null : `${pct(arc.hitRatio)} hit ratio` },
  ];

  const segmentIdsForContainers = (containers: DockerContainerTelemetry[]): string[] => [...new Set(
    containers
      .flatMap((container) => container.networkNames ?? [])
      .map((name) => networkSegmentByName.get(name)?.id)
      .filter((id): id is string => Boolean(id)),
  )].sort();
  const declaredControlNodeIds = new Set(
    (snapshot.fabricRelationships ?? [])
      .flatMap((declaration) => [declaredNode(declaration.from), declaredNode(declaration.to)])
      .filter((nodeId): nodeId is string => nodeId !== null),
  );
  const configuredServiceIds = new Set(
    scene.services
      .filter((service) => service.status !== "not-configured")
      .map((service) => service.id),
  );
  const stableCapabilities: FabricStableCapability[] = SERVICE_ORDER.map((id) => {
    const container = serviceContainers.get(id);
    const defaults = STABLE_SERVICE_CAPABILITIES[id];
    const optionallyConfiguredControl = id === "jellyfin" || id === "qbittorrent";
    const controlConfigured = defaults.control || declaredControlNodeIds.has(`service:${id}`) || (
      optionallyConfiguredControl && configuredServiceIds.has(id)
    );
    return {
      nodeId: `service:${id}`,
      ...defaults,
      control: controlConfigured,
      coverage: {
        ...defaults.coverage,
        control: controlConfigured ? "complete" : defaults.coverage.control,
      },
      networkSegmentIds: segmentIdsForContainers(container ? [container] : []),
    };
  });
  for (const node of nodes.filter((candidate) => candidate.kind === "storage")) {
    const control = declaredControlNodeIds.has(node.id);
    stableCapabilities.push({
      nodeId: node.id,
      network: false,
      control,
      read: true,
      write: true,
      networkSegmentIds: [],
      coverage: { network: "complete", control: "complete", read: "complete", write: "complete" },
    });
  }
  const aggregateCapability = (
    values: Array<{ value: boolean; coverage: FabricCoverage }>,
  ): { value: boolean; coverage: FabricCoverage } => {
    if (values.some((item) => item.value)) {
      return {
        value: true,
        coverage: values.every((item) => item.coverage === "complete") ? "complete" : "partial",
      };
    }
    if (values.length === 0 || values.every((item) => item.coverage === "unknown")) {
      return { value: false, coverage: "unknown" };
    }
    return {
      value: false,
      coverage: values.every((item) => item.coverage === "complete") ? "complete" : "partial",
    };
  };
  for (const group of groups) {
    const memberCapabilities = group.members.map((member) => ({
      network: {
        value: (member.networkNames?.length ?? 0) > 0,
        coverage: member.networkNames === undefined ? "unknown" as const : "complete" as const,
      },
      // The list-level Docker payload exposes neither mounts nor stable
      // application roles for grouped containers. Preserve that uncertainty
      // instead of turning live I/O counters into physical capabilities.
      control: { value: false, coverage: "unknown" as const },
      read: { value: false, coverage: "unknown" as const },
      write: { value: false, coverage: "unknown" as const },
    }));
    const network = aggregateCapability(memberCapabilities.map((member) => member.network));
    const control = aggregateCapability(memberCapabilities.map((member) => member.control));
    const read = aggregateCapability(memberCapabilities.map((member) => member.read));
    const write = aggregateCapability(memberCapabilities.map((member) => member.write));
    stableCapabilities.push({
      nodeId: group.id,
      network: network.value,
      control: control.value,
      read: read.value,
      write: write.value,
      networkSegmentIds: segmentIdsForContainers(group.members),
      coverage: {
        network: network.coverage,
        control: control.coverage,
        read: read.coverage,
        write: write.coverage,
      },
    });
  }

  return {
    regions: [
      { id: "region:resources", label: "Hardware accounting", bounds: { x: 18, y: 28, width: 914, height: 138 } },
      { id: "region:network", label: "External / gateway", bounds: { x: 18, y: 162, width: 156, height: 306 } },
      { id: "region:workloads", label: "Workloads / subsystems", bounds: { x: 196, y: 162, width: 736, height: 292 } },
      { id: "region:storage", label: "Storage substrate", bounds: { x: 196, y: 462, width: 736, height: 156 } },
      { id: "region:inspector", label: "Inspector dock", bounds: { x: 950, y: 28, width: 232, height: 590 } },
    ],
    trunks,
    nodes,
    ports,
    attachments,
    relationships,
    resourceViews,
    stableCapabilities,
    population: {
      total: snapshot.telemetry.docker.value?.total ?? null,
      represented: dockerContainers.length,
      running: snapshot.telemetry.docker.value?.running ?? null,
      groups,
      ids: dockerContainers.map(accountedContainerId),
      accountedNodes,
    },
    routing: { obstacles, lanes },
  };
}

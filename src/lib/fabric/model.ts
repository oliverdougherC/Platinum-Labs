import { formatBytes, formatCapacityPair, formatRate } from "@/lib/format/bytes";
import { groupWorkloads, type FabricWorkloadGroup } from "@/lib/fabric/groups";
import { boundsFor, type FabricBounds } from "@/lib/fabric/layout";
import {
  materializePort,
  portMap,
  type FabricPort,
  type FabricPortKind,
  type FabricPortSide,
} from "@/lib/fabric/ports";
import { routeBetweenPorts, routeViaPoints, type FabricRoute } from "@/lib/fabric/routing";
import { buildSceneModel, type BodyStatus, type ServiceId } from "@/lib/scene/model";
import { primaryRate, type FlowEndpoint, type FlowObservation } from "@/lib/topology/activity";
import type { DashboardSnapshot, FabricDeclaredRelationship, TelemetryStatus } from "@/lib/types";

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
}

export interface FabricPopulation {
  total: number | null;
  represented: number;
  running: number | null;
  groups: FabricWorkloadGroup[];
  ids: string[];
}

export interface FabricModel {
  regions: Array<{ id: string; label: string; bounds: FabricBounds }>;
  nodes: FabricNode[];
  ports: FabricPort[];
  attachments: FabricAttachment[];
  relationships: FabricRelationship[];
  resourceViews: FabricResourceView[];
  population: FabricPopulation;
}

export interface FabricModelOptions {
  now: number;
  seerrConfigured: boolean;
}

const SERVICE_ORDER: ServiceId[] = ["jellyfin", "qbittorrent", "sonarr", "radarr", "seerr"];

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

function flowWidth(rate: number | null, plane: "data" | "control"): number {
  if (plane === "control") return 1;
  if (rate === null || rate <= 0) return 1.5;
  const floor = 64_000;
  const ceiling = 250_000_000;
  const t = (Math.log10(Math.max(floor, rate)) - Math.log10(floor)) /
    (Math.log10(ceiling) - Math.log10(floor));
  return Number((1.8 + Math.max(0, Math.min(1, t)) * 5.2).toFixed(2));
}

function endpointNode(endpoint: FlowEndpoint, other: FlowEndpoint): string {
  if (endpoint.kind === "network") {
    const peer = other.kind === "service" ? other.id : "host";
    return `fabric:external:${peer}`;
  }
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
  return portId(nodeId, nodeId.startsWith("pool:") ? "read" : "control");
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

function routedFlow(flow: FlowObservation, fromPort: FabricPort, toPort: FabricPort): FabricRoute {
  if (flow.kind === "storage-transfer" || flow.kind === "organize") {
    const laneY = 376;
    return routeViaPoints(fromPort, toPort, [
      { x: fromPort.center.x + 14, y: fromPort.center.y },
      { x: fromPort.center.x + 14, y: laneY },
      { x: 903, y: laneY },
      { x: 903, y: toPort.center.y },
    ]);
  }
  if (flow.kind === "playback") {
    const laneY = 158;
    return routeViaPoints(fromPort, toPort, [
      { x: 869, y: fromPort.center.y },
      { x: 869, y: laneY },
      { x: toPort.center.x + 18, y: laneY },
      { x: toPort.center.x + 18, y: toPort.center.y },
    ]);
  }
  return routeBetweenPorts(fromPort, toPort, flow.plane === "control" ? -8 : 0);
}

function relationshipFromFlow(flow: FlowObservation, ports: Map<string, FabricPort>): FabricRelationship | null {
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
    route: routedFlow(flow, fromPort, toPort),
  };
}

function relationshipFromDeclaration(
  declaration: FabricDeclaredRelationship,
  ports: Map<string, FabricPort>,
  index: number,
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
    route: routeBetweenPorts(fromPort, toPort, 10 + index * 3),
  };
}

export function buildFabricModel(snapshot: DashboardSnapshot, options: FabricModelOptions): FabricModel {
  const scene = buildSceneModel(snapshot, options);
  const nodes: FabricNode[] = [];
  const ports: FabricPort[] = [];
  const attachments: FabricAttachment[] = [];

  const addNode = (node: FabricNode) => nodes.push(node);
  const addPort = (nodeId: string, bounds: FabricBounds, kind: FabricPortKind, side: FabricPortSide, offset: number, label: string) => {
    const port = materializePort({ id: portId(nodeId, kind), nodeId, kind, side, offset, label }, bounds);
    ports.push(port);
    return port;
  };

  const fabrics = [
    { id: "fabric:external", label: "HOST NETWORK", eyebrow: "WAN · LAN · OVERLAY", slot: "external-fabric" as const },
    { id: "fabric:service", label: "SERVICE CONTROL", eyebrow: "DECLARED + OBSERVED", slot: "service-fabric" as const },
    { id: "fabric:storage-read", label: "READ", eyebrow: "STORAGE FABRIC", slot: "storage-read-fabric" as const },
    { id: "fabric:storage-write", label: "WRITE", eyebrow: "STORAGE FABRIC", slot: "storage-write-fabric" as const },
  ];
  for (const fabric of fabrics) {
    addNode({ id: fabric.id, kind: "fabric", label: fabric.label, eyebrow: fabric.eyebrow, status: "healthy", bounds: boundsFor(fabric.slot), metrics: [] });
  }
  addPort("fabric:service", boundsFor("service-fabric"), "control", "bottom", 0.5, "Host control");

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
  const dockerContainers = snapshot.telemetry.docker.value?.containers ?? [];
  for (const [index, id] of SERVICE_ORDER.entries()) {
    const service = serviceById.get(id)!;
    const bounds = boundsFor("service", index);
    const nodeId = `service:${id}`;
    const metrics: FabricMetric[] = [];
    if (service.count !== null) metrics.push({ label: service.detail ?? "active", value: String(service.count) });
    if (id === "qbittorrent") {
      const rate = snapshot.acquisition.rollup.aggregateRateBps;
      metrics.push({ label: "down", value: rate === null ? "—" : formatRate(rate) });
    }
    addNode({ id: nodeId, kind: "workload", label: service.label, eyebrow: service.active ? (service.detail ?? "ACTIVE").toUpperCase() : "SERVICE", status: statusFromBody(service.status), bounds, metrics: metrics.slice(0, 2) });
    const network = addPort(nodeId, bounds, "network", "top", 0.28, "Network");
    const control = addPort(nodeId, bounds, "control", "top", 0.72, "Control");
    addPort(nodeId, bounds, "read", "right", 0.34, "Read");
    addPort(nodeId, bounds, "write", "right", 0.7, "Write");

    const extBounds = boundsFor("external-fabric");
    const ext = materializePort({ id: `fabric:external:${id}:network`, nodeId: `fabric:external:${id}`, kind: "network", side: "bottom", offset: 0.27 + index * 0.105, label: `${service.label} network attachment` }, extBounds);
    ports.push(ext);
    const ctlBounds = boundsFor("service-fabric");
    const ctl = materializePort({ id: `fabric:service:${id}:control`, nodeId: "fabric:service", kind: "control", side: "bottom", offset: 0.12 + index * 0.19, label: `${service.label} control attachment` }, ctlBounds);
    ports.push(ctl);
    const expectedNames = id === "seerr" ? ["seerr", "jellyseerr"] : [id];
    const configuredJellyfin = id === "jellyfin" ? snapshot.jellyfinContainer?.toLowerCase() : null;
    const matchingContainer = dockerContainers.find((container) => {
      const name = container.name.toLowerCase();
      const composeService = container.composeService?.toLowerCase();
      return (configuredJellyfin !== null && name === configuredJellyfin) ||
        expectedNames.includes(composeService ?? "") ||
        expectedNames.includes(name);
    });
    const networkNames = matchingContainer?.networkNames ?? [];
    attachments.push({ id: `attach:network:${id}`, nodeId, fabricId: "fabric:external", kind: "network", known: networkNames.length > 0, label: networkNames.length ? networkNames.join(" · ") : "Network membership unavailable", route: routeBetweenPorts(ext, network) });
    attachments.push({ id: `attach:control:${id}`, nodeId, fabricId: "fabric:service", kind: "control", known: service.status !== "not-configured", label: "Service control attachment", route: routeBetweenPorts(ctl, control) });
  }

  // Alias ports make the shared host network the endpoint for each observed service flow.
  for (const id of SERVICE_ORDER) {
    const attachment = ports.find((port) => port.id === `fabric:external:${id}:network`);
    if (attachment) ports.push({ ...attachment, id: `fabric:external:${id}:network`, nodeId: `fabric:external:${id}` });
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
    const read = addPort(nodeId, bounds, "read", "left", 0.34, "Read");
    const write = addPort(nodeId, bounds, "write", "left", 0.7, "Write");
    const readFabricBounds = boundsFor("storage-read-fabric");
    const writeFabricBounds = boundsFor("storage-write-fabric");
    const readFabric = materializePort({
      id: `fabric:storage-read:${pool.name}:read`,
      nodeId: "fabric:storage-read",
      kind: "read",
      side: "right",
      offset: (read.center.y - readFabricBounds.y) / readFabricBounds.height,
      label: `${pool.name} read attachment`,
    }, readFabricBounds);
    const writeFabric = materializePort({
      id: `fabric:storage-write:${pool.name}:write`,
      nodeId: "fabric:storage-write",
      kind: "write",
      side: "right",
      offset: (write.center.y - writeFabricBounds.y) / writeFabricBounds.height,
      label: `${pool.name} write attachment`,
    }, writeFabricBounds);
    ports.push(readFabric, writeFabric);
    attachments.push({ id: `attach:read:${pool.name}`, nodeId, fabricId: "fabric:storage-read", kind: "read", known: pool.name !== "unmapped", label: `${pool.name} read fabric`, route: routeBetweenPorts(readFabric, read) });
    attachments.push({ id: `attach:write:${pool.name}`, nodeId, fabricId: "fabric:storage-write", kind: "write", known: pool.name !== "unmapped", label: `${pool.name} write fabric`, route: routeBetweenPorts(writeFabric, write) });
  });

  const groups = groupWorkloads(dockerContainers);
  groups.forEach((group, index) => {
    const bounds = boundsFor("group", index);
    const status: FabricNodeStatus = group.attentionCount > 0 ? "degraded" : snapshot.telemetry.docker.status === "available" ? "healthy" : snapshot.telemetry.docker.status;
    addNode({ id: group.id, kind: "group", label: group.label, eyebrow: `${group.members.length} WORKLOAD${group.members.length === 1 ? "" : "S"}`, status, bounds, metrics: group.attentionCount ? [{ label: "attention", value: String(group.attentionCount) }] : [] });
    const network = addPort(group.id, bounds, "network", "top", 0.5, "Network");
    const extBounds = boundsFor("external-fabric");
    const ext = materializePort({ id: `fabric:external:${group.id}:network`, nodeId: "fabric:external", kind: "network", side: "bottom", offset: 0.235 + index * 0.01, label: `${group.label} network attachment` }, extBounds);
    ports.push(ext);
    const names = [...new Set(group.members.flatMap((member) => member.networkNames ?? []))].sort();
    attachments.push({
      id: `attach:network:${group.id}`,
      nodeId: group.id,
      fabricId: "fabric:external",
      kind: "network",
      known: names.length > 0,
      label: names.length ? names.join(" · ") : "Network membership unavailable",
      route: routeViaPoints(ext, network, [
        { x: ext.center.x, y: 96 },
        { x: 314, y: 96 },
        { x: 314, y: 380 },
        { x: network.center.x, y: 380 },
      ]),
    });
  });

  const byPort = portMap(ports);
  const relationships = scene.flows.flatMap((flow) => {
    const relationship = relationshipFromFlow(flow, byPort);
    return relationship ? [relationship] : [];
  });
  for (const [index, declaration] of (snapshot.fabricRelationships ?? []).entries()) {
    const relationship = relationshipFromDeclaration(declaration, byPort, index);
    if (relationship && !relationships.some((item) => item.fromNodeId === relationship.fromNodeId && item.toNodeId === relationship.toNodeId && item.plane === "control")) relationships.push(relationship);
  }

  const resourceViews: FabricResourceView[] = [
    { id: "cpu", nodeId: "resource:cpu", status: freshness(snapshot.telemetry.cpu.status), fraction: scene.core.totalFraction, segments: scene.core.perCore, primary: scene.core.totalFraction === null ? "Unknown" : `${(scene.core.totalFraction * scene.core.perCore.length).toFixed(1)} cores used`, secondary: `${scene.core.perCore.length} logical CPUs` },
    { id: "memory", nodeId: "resource:memory", status: freshness(snapshot.telemetry.memory.status), fraction: scene.core.memFraction, segments: scene.core.memFraction === null ? [] : [scene.core.memFraction], primary: scene.core.memUsedBytes === null ? "Unknown" : `${formatBytes(scene.core.memUsedBytes)} charged`, secondary: scene.core.memTotalBytes === null ? null : `${formatBytes(scene.core.memTotalBytes)} total` },
    { id: "gpu", nodeId: "resource:gpu", status: freshness(snapshot.telemetry.gpu.status), fraction: gpu?.utilizationFraction ?? null, segments: gpu ? [gpu.utilizationFraction, gpu.vramTotalBytes > 0 ? gpu.vramUsedBytes / gpu.vramTotalBytes : 0] : [], primary: gpu ? `${pct(gpu.utilizationFraction)} engine` : "Not configured", secondary: gpu ? `${formatBytes(gpu.vramUsedBytes)} VRAM` : null },
    { id: "arc", nodeId: "resource:arc", status: freshness(snapshot.telemetry.arc.status), fraction: arc?.targetBytes && arc.targetBytes > 0 ? arc.sizeBytes / arc.targetBytes : null, segments: arc ? [arc.targetBytes && arc.targetBytes > 0 ? arc.sizeBytes / arc.targetBytes : 0] : [], primary: arc ? `${formatBytes(arc.sizeBytes)} resident` : "Unknown", secondary: arc?.hitRatio === null || arc?.hitRatio === undefined ? null : `${pct(arc.hitRatio)} hit ratio` },
  ];

  return {
    regions: [
      { id: "region:resources", label: "Hardware", bounds: { x: 28, y: 104, width: 278, height: 508 } },
      { id: "region:workloads", label: "Workloads", bounds: { x: 312, y: 104, width: 542, height: 508 } },
      { id: "region:storage", label: "Storage", bounds: { x: 922, y: 104, width: 250, height: 508 } },
    ],
    nodes,
    ports,
    attachments,
    relationships,
    resourceViews,
    population: {
      total: snapshot.telemetry.docker.value?.total ?? null,
      represented: dockerContainers.length,
      running: snapshot.telemetry.docker.value?.running ?? null,
      groups,
      ids: dockerContainers.map((container) => container.stableId ?? `name-${container.name}`),
    },
  };
}

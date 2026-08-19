import { describe, expect, it } from "vitest";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";
import { buildFabricModel } from "@/lib/fabric/model";
import aPlusGeometryFixture from "@/lib/fabric/__fixtures__/a-plus-geometry.json";
import {
  buildFabricComposition,
  validateFabricComposition,
  validateLogicalRoute,
} from "@/lib/fabric/composition-study";

const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);

function modelFor(
  scenario: Parameters<typeof makeFakeSnapshot>[0],
  {
    networkBoundaries,
    networkBoundaryByFlowId,
  }: {
    networkBoundaries?: readonly ("wan" | "lan" | "overlay")[];
    networkBoundaryByFlowId?: Readonly<Record<string, "wan" | "lan" | "overlay" | "docker-internal" | "host-local" | "unknown">>;
  } = {},
) {
  const activity = makeFakeSnapshot(scenario, NOW);
  const realScale = makeFakeSnapshot("container-field-real", NOW);
  return buildFabricModel({
    ...activity,
    telemetry: { ...activity.telemetry, docker: realScale.telemetry.docker },
  }, {
    now: NOW,
    seerrConfigured: true,
    networkBoundaries,
    networkBoundaryByFlowId,
  });
}

function aPlusGeometry(scene: ReturnType<typeof buildFabricComposition>) {
  return {
    nodes: scene.nodes.map((node) => ({
      id: node.sourceNodeId,
      bounds: node.bounds,
      ports: node.ports.map((port) => ({ id: port.id, kind: port.kind, center: port.center })),
    })),
    junctions: scene.junctions.map((junction) => ({
      id: junction.id,
      plane: junction.plane,
      kind: junction.kind,
      point: junction.point,
    })),
    segments: scene.segments.map((segment) => ({
      id: segment.id,
      plane: segment.plane,
      endpointIds: segment.endpointIds,
      junctionIds: segment.junctionIds,
      points: segment.points,
    })),
    primaryStorageCorridors: scene.primaryStorageCorridors,
  };
}

function checksum(value: string) {
  let hash = 0;
  for (const char of value) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

function aPlusGeometryFingerprint(scene: ReturnType<typeof buildFabricComposition>) {
  const geometry = aPlusGeometry(scene);
  return checksum(JSON.stringify({
    nodes: geometry.nodes.map((node) => `${node.id}:${node.bounds.x},${node.bounds.y},${node.bounds.width},${node.bounds.height}`),
    junctions: geometry.junctions.map((junction) => `${junction.id}:${junction.plane}:${junction.kind}:${junction.point.x},${junction.point.y}`),
    segments: geometry.segments.map((segment) => `${segment.id}:${segment.plane}:${segment.endpointIds.join("->")}:${segment.points.map((point) => `${point.x},${point.y}`).join(";")}`),
    corridors: geometry.primaryStorageCorridors.map((corridor) => `${corridor.nodeId}:${corridor.bounds.x},${corridor.bounds.y},${corridor.bounds.width},${corridor.bounds.height}`),
  }));
}

function routeFor(scene: ReturnType<typeof buildFabricComposition>, relationshipId: string) {
  return scene.logicalRoutes.find((route) => route.relationshipId === relationshipId);
}

function minimumUnrelatedModuleGap(scene: ReturnType<typeof buildFabricComposition>) {
  const modules = scene.nodes.filter((node) =>
    ["orchestration", "data-plane", "subsystem", "storage"].includes(node.role),
  );
  let minimum = Number.POSITIVE_INFINITY;
  let pair = "";
  for (let index = 0; index < modules.length; index += 1) {
    for (let peerIndex = index + 1; peerIndex < modules.length; peerIndex += 1) {
      const left = modules[index]!;
      const right = modules[peerIndex]!;
      const dx = Math.max(0, left.bounds.x - (right.bounds.x + right.bounds.width), right.bounds.x - (left.bounds.x + left.bounds.width));
      const dy = Math.max(0, left.bounds.y - (right.bounds.y + right.bounds.height), right.bounds.y - (left.bounds.y + left.bounds.height));
      const gap = Number(Math.hypot(dx, dy).toFixed(2));
      if (gap < minimum) {
        minimum = gap;
        pair = `${left.sourceNodeId}:${right.sourceNodeId}`;
      }
    }
  }
  return { minimum, pair };
}

describe("fabric composition studies", () => {
  it("builds an A+ synthesis with attached visible ports and endpoint-specific logical branches", () => {
    const scene = buildFabricComposition(modelFor("container-mixed", { networkBoundaries: ["wan", "lan", "overlay"] }), "A+");
    const validation = validateFabricComposition(scene);

    expect(scene.id).toBe("A+");
    expect(scene.logicalRoutes.filter((route) => route.resolution === "complete").every((route) => route.segmentIds.length > 0)).toBe(true);
    expect(validation.unattachedPortIds).toEqual([]);
    expect(validation.trunkOnlyRouteIds).toEqual([]);
    expect(validation.duplicateGeometry).toEqual([]);
    expect(validation.segmentNodeIntersections).toEqual([]);
    expect(validation.segmentLabelIntersections).toEqual([]);
  });

  it("keeps the A+ storage corridors clear and rejects large internal voids with coarse-grid density", () => {
    const scene = buildFabricComposition(modelFor("container-field-real", { networkBoundaries: ["wan", "lan", "overlay"] }), "A+");
    const validation = validateFabricComposition(scene);
    const moduleGap = minimumUnrelatedModuleGap(scene);

    expect(validation.blockedStorageCorridors).toEqual([]);
    expect(moduleGap.minimum, moduleGap.pair).toBeGreaterThanOrEqual(12);
    expect(validation.density.occupiedCellRatio).toBeGreaterThanOrEqual(0.34);
    expect(validation.density.largestInternalVoid).toBeLessThanOrEqual(8);
    expect(validation.density.columns.slice(0, 4).some((count) => count > 0)).toBe(true);
    expect(validation.density.columns.slice(4, 8).some((count) => count > 0)).toBe(true);
    expect(validation.density.columns.slice(8).some((count) => count > 0)).toBe(true);
    expect(validation.missingPopulationIds).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it("keeps the A+ physical graph byte-for-byte stable across the required scenario matrix", () => {
    const scenarios = [
      "idle",
      "direct-play",
      "transcode",
      "downloads",
      "seeding",
      "same-pool-import",
      "cross-pool-import",
      "container-mixed",
      "relationship-map",
      "stale",
      "docker-unavailable",
    ] as const;
    const geometries = scenarios.map((scenario) =>
      aPlusGeometry(buildFabricComposition(modelFor(scenario, { networkBoundaries: ["wan", "lan", "overlay"] }), "A+")),
    );
    expect(geometries.slice(1).every((geometry) => JSON.stringify(geometry) === JSON.stringify(geometries[0]))).toBe(true);
  });

  it("locks the exact A+ node port junction segment and corridor geometry contract", () => {
    const scene = buildFabricComposition(modelFor("idle", { networkBoundaries: ["wan", "lan", "overlay"] }), "A+");

    expect(aPlusGeometry(scene)).toEqual(aPlusGeometryFixture);
    expect(aPlusGeometryFingerprint(scene)).toBe("aeaa2ae4");
    expect(scene.segments.some((segment) => segment.id === "segment:a-plus:host-network-trunk")).toBe(true);
  });

  it("keeps network-boundary truth for WAN, LAN, overlay, internal, and unknown routes", () => {
    const lanScene = buildFabricComposition(modelFor("direct-play", {
      networkBoundaries: ["wan", "lan", "overlay"],
      networkBoundaryByFlowId: { "egress:jellyfin->network": "lan" },
    }), "A+");
    const overlayScene = buildFabricComposition(modelFor("direct-play", {
      networkBoundaries: ["wan", "lan", "overlay"],
      networkBoundaryByFlowId: { "egress:jellyfin->network": "overlay" },
    }), "A+");
    const wanScene = buildFabricComposition(modelFor("downloads", { networkBoundaries: ["wan", "lan", "overlay"] }), "A+");

    const internalModel = modelFor("relationship-map", { networkBoundaries: ["wan", "lan", "overlay"] });
    const template = internalModel.relationships.find((relationship) => relationship.fromPortId.endsWith(":network") && relationship.toPortId.endsWith(":network"))!;
    internalModel.relationships.push({
      ...template,
      id: "declared:internal:sonarr->jellyfin",
      label: "Jellyfin internal API",
      fromNodeId: "service:sonarr",
      toNodeId: "service:jellyfin",
      fromPortId: "service:sonarr:network",
      toPortId: "service:jellyfin:network",
      networkBoundary: "docker-internal",
      direction: "forward",
      visibility: "focus",
      route: template.route,
    });
    const internalScene = buildFabricComposition(internalModel, "A+");

    const unknownModel = modelFor("direct-play", { networkBoundaries: ["wan", "lan", "overlay"] });
    const unknownTemplate = unknownModel.relationships.find((relationship) => relationship.id === "egress:jellyfin->network")!;
    unknownModel.relationships.push({
      ...unknownTemplate,
      id: "declared:unknown:jellyfin-network",
      label: "Jellyfin unknown network boundary",
      networkBoundary: "unknown",
      route: unknownTemplate.route,
    });
    const unknownScene = buildFabricComposition(unknownModel, "A+");

    expect(routeFor(lanScene, "egress:jellyfin->network")).toMatchObject({
      resolution: "partial",
      networkResolution: {
        status: "ambiguous",
        candidateSegmentIds: ["network:internal_default", "network:media_default"],
      },
      segmentIds: [],
    });
    expect(routeFor(lanScene, "egress:jellyfin->network:gateway-boundary:lan")?.segmentIds).toEqual(["segment:a-plus:lan-gateway"]);
    expect(routeFor(overlayScene, "egress:jellyfin->network")).toMatchObject({
      resolution: "partial",
      networkResolution: {
        status: "ambiguous",
        candidateSegmentIds: ["network:internal_default", "network:media_default"],
      },
      segmentIds: [],
    });
    expect(routeFor(overlayScene, "egress:jellyfin->network:gateway-boundary:overlay")?.segmentIds).toEqual(["segment:a-plus:overlay-gateway"]);
    expect(routeFor(wanScene, "wan-transfer:network->qbittorrent:gateway-boundary:wan")?.segmentIds).toEqual(["segment:a-plus:wan-gateway"]);
    expect(routeFor(internalScene, "declared:internal:sonarr->jellyfin")).toMatchObject({
      resolution: "partial",
      networkResolution: {
        status: "ambiguous",
        candidateSegmentIds: ["network:internal_default", "network:media_default"],
      },
      segmentIds: [],
    });
    expect(routeFor(unknownScene, "declared:unknown:jellyfin-network")).toMatchObject({
      resolution: "partial",
      networkResolution: {
        status: "ambiguous",
        candidateSegmentIds: ["network:internal_default", "network:media_default"],
      },
      segmentIds: [],
    });
    expect(lanScene.segments.map((segment) => segment.id)).toEqual(expect.arrayContaining([
      "segment:a-plus:wan-gateway",
      "segment:a-plus:lan-gateway",
      "segment:a-plus:overlay-gateway",
    ]));
  });

  it("models cross-pool import as separate continuous read and write operations from relationship controller metadata", () => {
    const model = modelFor("cross-pool-import", { networkBoundaries: ["wan", "lan", "overlay"] });
    const importRelationship = model.relationships.find((relationship) => relationship.id === "import-copy:pool:NVME->pool:DataStore")!;
    Object.assign(importRelationship, { controllerServiceId: "service:radarr" });
    const scene = buildFabricComposition(model, "A+");
    const readOperation = scene.logicalRoutes.find((route) => route.relationshipId === "import-copy:pool:NVME->pool:DataStore:read-operation");
    const writeOperation = scene.logicalRoutes.find((route) => route.relationshipId === "import-copy:pool:NVME->pool:DataStore:write-operation");

    expect(readOperation).toBeDefined();
    expect(writeOperation).toBeDefined();
    expect(readOperation?.toPortId).toBe("service:radarr:read");
    expect(writeOperation?.fromPortId).toBe("service:radarr:write");
    expect(validateLogicalRoute(readOperation!, scene.segments)).toMatchObject({ continuous: true, startsAtSource: true, endsAtDestination: true });
    expect(validateLogicalRoute(writeOperation!, scene.segments)).toMatchObject({ continuous: true, startsAtSource: true, endsAtDestination: true });
    expect(buildFabricComposition(modelFor("same-pool-import", { networkBoundaries: ["wan", "lan", "overlay"] }), "A+").logicalRoutes.some((route) =>
      route.relationshipId.startsWith("import-copy:"),
    )).toBe(false);
  });

  it("keeps route continuity and via policy within the A+ review budget", () => {
    const scene = buildFabricComposition(modelFor("relationship-map", { networkBoundaries: ["wan", "lan", "overlay"] }), "A+");
    const validation = validateFabricComposition(scene);

    expect(validation.routeValidationFailures).toEqual([]);
    expect(validation.unapprovedCrossings).toEqual([]);
    expect(validation.viaCount).toBeLessThanOrEqual(4);
    expect(Object.values(validation.viaCountByRegion).every((count) => count <= 2)).toBe(true);
    expect(validation.undeclaredViaIds).toEqual([]);
    expect(validation.prohibitedViaIds).toEqual([]);
  });

  it("preserves multi-homed workload and group membership as separate physical network branches", () => {
    const scene = buildFabricComposition(modelFor("container-field-real", { networkBoundaries: ["wan", "lan", "overlay"] }), "A+");

    expect(scene.segments.map((segment) => segment.id)).toEqual(expect.arrayContaining([
      "segment:a-plus:network:internal_default:service:jellyfin:network-branch",
      "segment:a-plus:network:other-docker-segments:service:jellyfin:network-branch",
      "segment:a-plus:network:internal_default:service:sonarr:network-branch",
      "segment:a-plus:network:other-docker-segments:service:sonarr:network-branch",
      "segment:a-plus:network:bridge:group:media-support:network-branch",
      "segment:a-plus:network:internal_default:group:media-support:network-branch",
      "segment:a-plus:network:other-docker-segments:group:media-support:network-branch",
    ]));
  });

  it("selects the one shared network among several and marks none-shared or many-shared routes partial", () => {
    const model = modelFor("relationship-map", { networkBoundaries: ["wan", "lan", "overlay"] });
    const jellyfin = model.stableCapabilities.find((capability) => capability.nodeId === "service:jellyfin")!;
    const sonarr = model.stableCapabilities.find((capability) => capability.nodeId === "service:sonarr")!;
    const radarr = model.stableCapabilities.find((capability) => capability.nodeId === "service:radarr")!;
    jellyfin.networkSegmentIds = ["network:internal_default", "network:media_default"];
    sonarr.networkSegmentIds = ["network:bridge", "network:internal_default"];
    radarr.networkSegmentIds = ["network:bridge"];
    const template = model.relationships.find((relationship) => relationship.fromPortId.endsWith(":network") && relationship.toPortId.endsWith(":network"))!;
    model.relationships.push(
      {
        ...template,
        id: "declared:unique-shared:sonarr->jellyfin",
        label: "Unique shared network",
        fromNodeId: "service:sonarr",
        toNodeId: "service:jellyfin",
        fromPortId: "service:sonarr:network",
        toPortId: "service:jellyfin:network",
        networkBoundary: "docker-internal",
        direction: "forward",
        visibility: "focus",
      },
      {
        ...template,
        id: "declared:none-shared:radarr->jellyfin",
        label: "No shared network",
        fromNodeId: "service:radarr",
        toNodeId: "service:jellyfin",
        fromPortId: "service:radarr:network",
        toPortId: "service:jellyfin:network",
        networkBoundary: "docker-internal",
        direction: "forward",
        visibility: "focus",
      },
      {
        ...template,
        id: "declared:many-shared:jellyfin->seerr",
        label: "Many shared networks",
        fromNodeId: "service:jellyfin",
        toNodeId: "service:seerr",
        fromPortId: "service:jellyfin:network",
        toPortId: "service:seerr:network",
        networkBoundary: "docker-internal",
        direction: "forward",
        visibility: "focus",
      },
      {
        ...template,
        id: "declared:grouped-display-only:jellyfin->observability",
        label: "Grouped display network only",
        fromNodeId: "service:jellyfin",
        toNodeId: "group:observability",
        fromPortId: "service:jellyfin:network",
        toPortId: "group:observability:network",
        networkBoundary: "docker-internal",
        direction: "forward",
        visibility: "focus",
      },
    );

    const scene = buildFabricComposition(model, "A+");

    expect(routeFor(scene, "declared:unique-shared:sonarr->jellyfin")).toMatchObject({
      resolution: "complete",
      networkResolution: {
        status: "resolved",
        selectedSegmentId: "network:internal_default",
        candidateSegmentIds: ["network:internal_default"],
      },
      segmentIds: [
        "segment:a-plus:network:internal_default:service:sonarr:network-branch",
        "segment:a-plus:network:internal_default:rail",
        "segment:a-plus:network:east-trunk",
        "segment:a-plus:network:internal_default:service:jellyfin:network-branch",
      ],
    });
    expect(routeFor(scene, "declared:none-shared:radarr->jellyfin")).toMatchObject({
      resolution: "partial",
      networkResolution: {
        status: "unresolved",
        candidateSegmentIds: [],
      },
      segmentIds: [],
    });
    expect(routeFor(scene, "declared:many-shared:jellyfin->seerr")).toMatchObject({
      resolution: "partial",
      networkResolution: {
        status: "ambiguous",
        candidateSegmentIds: ["network:internal_default", "network:media_default"],
      },
      segmentIds: [],
    });
    expect(routeFor(scene, "declared:grouped-display-only:jellyfin->observability")).toMatchObject({
      resolution: "complete",
      networkResolution: {
        status: "resolved",
        selectedSegmentId: "network:internal_default",
        candidateSegmentIds: ["network:internal_default"],
      },
      segmentIds: [
        "segment:a-plus:network:internal_default:service:jellyfin:network-branch",
        "segment:a-plus:network:east-trunk",
        "segment:a-plus:network:internal_default:rail",
        "segment:a-plus:host-network-trunk",
        "segment:a-plus:network:internal_default:group:observability:network-branch",
      ],
    });
  });

  it("exposes subsystem focus metadata for aggregate resources and selected branch highlighting", () => {
    const scene = buildFabricComposition(modelFor("container-field-real", { networkBoundaries: ["wan", "lan", "overlay"] }), "A+");

    expect(scene.subsystemFocus).toMatchObject({
      resourceNodeIds: ["resource:cpu", "resource:memory"],
      resourceViewIds: ["cpu", "memory"],
    });
    expect(scene.subsystemFocus.byNodeId["group:media-support"]).toMatchObject({
      networkSegmentIds: ["network:bridge", "network:internal_default", "network:media_default"],
      networkBranchSegmentIds: expect.arrayContaining([
        "segment:a-plus:network:bridge:group:media-support:network-branch",
        "segment:a-plus:network:internal_default:group:media-support:network-branch",
        "segment:a-plus:network:other-docker-segments:group:media-support:network-branch",
      ]),
    });
    expect(scene.segments.find((segment) => segment.id === "segment:a-plus:network:bridge:group:media-support:network-branch")).toMatchObject({
      subsystemFocus: {
        nodeIds: ["group:media-support"],
        kind: "network",
        networkSegmentIds: ["network:bridge"],
        connectivity: "membership",
      },
    });
  });

  it("reports disconnected repeated backtracking and cross-plane routes", () => {
    const scene = buildFabricComposition(modelFor("idle", { networkBoundaries: ["wan", "lan", "overlay"] }), "A+");

    expect(validateLogicalRoute({
      relationshipId: "synthetic:disconnected",
      contributorRelationshipId: "synthetic:disconnected",
      label: "synthetic",
      plane: "data",
      segmentIds: [
        "segment:a-plus:wan-gateway",
        "segment:a-plus:control:substrate",
        "segment:a-plus:wan-gateway",
      ],
      fromNodeId: "external:wan",
      toNodeId: "service:sonarr",
      fromPortId: "external:wan:network",
      toPortId: "service:sonarr:control",
      direction: "forward",
      evidence: "derived",
      networkBoundary: "wan",
      resolution: "complete",
    }, scene.segments)).toEqual({
      continuous: false,
      startsAtSource: true,
      endsAtDestination: false,
      directionPreserved: false,
      disconnectedPairs: [
        ["segment:a-plus:wan-gateway", "segment:a-plus:control:substrate"],
        ["segment:a-plus:control:substrate", "segment:a-plus:wan-gateway"],
      ],
      repeatedSegments: ["segment:a-plus:wan-gateway"],
      backtracks: ["segment:a-plus:wan-gateway"],
      planeTransitions: [
        ["segment:a-plus:wan-gateway", "segment:a-plus:control:substrate"],
        ["segment:a-plus:control:substrate", "segment:a-plus:wan-gateway"],
      ],
    });

    expect(validateLogicalRoute({
      relationshipId: "synthetic:direction",
      contributorRelationshipId: "synthetic:direction",
      label: "synthetic",
      plane: "data",
      segmentIds: ["synthetic:first", "synthetic:second"],
      fromNodeId: "source",
      toNodeId: "destination",
      fromPortId: "source:network",
      toPortId: "destination:network",
      direction: "forward",
      evidence: "derived",
      networkBoundary: "host-local",
      resolution: "complete",
    }, [
      {
        id: "synthetic:first", plane: "network", endpointIds: ["source:network", "junction:first"],
        junctionIds: [], points: [], label: "", labelBounds: { x: 0, y: 0, width: 0, height: 0 },
        logicalContributorIds: [], directions: [],
      },
      {
        id: "synthetic:second", plane: "network", endpointIds: ["source:network", "destination:network"],
        junctionIds: [], points: [], label: "", labelBounds: { x: 0, y: 0, width: 0, height: 0 },
        logicalContributorIds: [], directions: [],
      },
    ])).toMatchObject({
      continuous: false,
      startsAtSource: true,
      endsAtDestination: true,
      directionPreserved: false,
      disconnectedPairs: [],
      planeTransitions: [],
    });
  });

  it("keeps non-boundary endpoint route resolution stable when only the external boundary activity changes", () => {
    const lanScene = buildFabricComposition(modelFor("direct-play", {
      networkBoundaries: ["wan", "lan", "overlay"],
      networkBoundaryByFlowId: { "egress:jellyfin->network": "lan" },
    }), "A+");
    const overlayScene = buildFabricComposition(modelFor("direct-play", {
      networkBoundaries: ["wan", "lan", "overlay"],
      networkBoundaryByFlowId: { "egress:jellyfin->network": "overlay" },
    }), "A+");
    const wanScene = buildFabricComposition(modelFor("downloads", { networkBoundaries: ["wan", "lan", "overlay"] }), "A+");

    expect(routeFor(lanScene, "egress:jellyfin->network")).toMatchObject({
      resolution: "partial",
      networkResolution: { status: "ambiguous", candidateSegmentIds: ["network:internal_default", "network:media_default"] },
      segmentIds: [],
    });
    expect(routeFor(overlayScene, "egress:jellyfin->network")).toMatchObject({
      resolution: "partial",
      networkResolution: { status: "ambiguous", candidateSegmentIds: ["network:internal_default", "network:media_default"] },
      segmentIds: [],
    });
    expect(routeFor(wanScene, "wan-transfer:network->qbittorrent")).toMatchObject({
      resolution: "partial",
      networkResolution: { status: "ambiguous", candidateSegmentIds: ["network:internal_default", "network:media_default"] },
      segmentIds: [],
    });
  });
});

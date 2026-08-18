import { describe, expect, it } from "vitest";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";
import { buildFabricModel } from "@/lib/fabric/model";
import {
  buildFabricComposition,
  validateFabricComposition,
  validateLogicalRoute,
  type FabricCompositionId,
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

function routeFor(scene: ReturnType<typeof buildFabricComposition>, relationshipId: string) {
  return scene.logicalRoutes.find((route) => route.relationshipId === relationshipId);
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

  it("builds an A+ synthesis with attached visible ports and endpoint-specific logical branches", () => {
    const scene = buildFabricComposition(modelFor("container-mixed", { networkBoundaries: ["wan", "lan", "overlay"] }), "A+");
    const validation = validateFabricComposition(scene);

    expect(scene.id).toBe("A+");
    expect(scene.logicalRoutes.every((route) => route.segmentIds.length > 0)).toBe(true);
    expect(validation.unattachedPortIds).toEqual([]);
    expect(validation.trunkOnlyRouteIds).toEqual([]);
    expect(validation.duplicateGeometry).toEqual([]);
    expect(validation.segmentNodeIntersections).toEqual([]);
    expect(validation.segmentLabelIntersections).toEqual([]);
  });

  it("keeps the A+ storage corridors clear and rejects large internal voids with coarse-grid density", () => {
    const scene = buildFabricComposition(modelFor("container-field-real", { networkBoundaries: ["wan", "lan", "overlay"] }), "A+");
    const validation = validateFabricComposition(scene);

    expect(validation.blockedStorageCorridors).toEqual([]);
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
    expect(aPlusGeometry(scene)).toMatchInlineSnapshot(`
      {
        "junctions": [
          {
            "id": "junction:a-plus:host-network-root",
            "kind": "junction",
            "plane": "network",
            "point": {
              "x": 272,
              "y": 247,
            },
          },
          {
            "id": "junction:a-plus:network:other-docker-segments:host",
            "kind": "junction",
            "plane": "network",
            "point": {
              "x": 272,
              "y": 293,
            },
          },
          {
            "id": "junction:a-plus:network:bridge:host",
            "kind": "junction",
            "plane": "network",
            "point": {
              "x": 272,
              "y": 333,
            },
          },
          {
            "id": "junction:a-plus:network:internal_default:host",
            "kind": "junction",
            "plane": "network",
            "point": {
              "x": 272,
              "y": 373,
            },
          },
          {
            "id": "junction:a-plus:network:other-docker-segments:rail-root",
            "kind": "junction",
            "plane": "network",
            "point": {
              "x": 272,
              "y": 126,
            },
          },
          {
            "id": "junction:a-plus:network:bridge:rail-root",
            "kind": "junction",
            "plane": "network",
            "point": {
              "x": 272,
              "y": 134,
            },
          },
          {
            "id": "junction:a-plus:network:internal_default:rail-root",
            "kind": "junction",
            "plane": "network",
            "point": {
              "x": 272,
              "y": 142,
            },
          },
          {
            "id": "junction:a-plus:network:other-docker-segments:rail-east",
            "kind": "junction",
            "plane": "network",
            "point": {
              "x": 356,
              "y": 126,
            },
          },
          {
            "id": "junction:a-plus:network:bridge:group:media-support",
            "kind": "junction",
            "plane": "network",
            "point": {
              "x": 272,
              "y": 476,
            },
          },
          {
            "id": "junction:a-plus:network:bridge:rail-east",
            "kind": "junction",
            "plane": "network",
            "point": {
              "x": 1194,
              "y": 134,
            },
          },
          {
            "id": "junction:a-plus:network:internal_default:service:jellyfin",
            "kind": "junction",
            "plane": "network",
            "point": {
              "x": 1196,
              "y": 318,
            },
          },
          {
            "id": "junction:a-plus:network:internal_default:service:qbittorrent",
            "kind": "junction",
            "plane": "network",
            "point": {
              "x": 272,
              "y": 318,
            },
          },
          {
            "id": "junction:a-plus:network:internal_default:service:sonarr",
            "kind": "junction",
            "plane": "network",
            "point": {
              "x": 719,
              "y": 142,
            },
          },
          {
            "id": "junction:a-plus:network:internal_default:service:radarr",
            "kind": "junction",
            "plane": "network",
            "point": {
              "x": 1023,
              "y": 142,
            },
          },
          {
            "id": "junction:a-plus:network:internal_default:service:seerr",
            "kind": "junction",
            "plane": "network",
            "point": {
              "x": 415,
              "y": 142,
            },
          },
          {
            "id": "junction:a-plus:network:internal_default:group:platform",
            "kind": "junction",
            "plane": "network",
            "point": {
              "x": 272,
              "y": 426,
            },
          },
          {
            "id": "junction:a-plus:network:internal_default:group:observability",
            "kind": "junction",
            "plane": "network",
            "point": {
              "x": 272,
              "y": 526,
            },
          },
          {
            "id": "junction:a-plus:network:internal_default:group:network-edge",
            "kind": "junction",
            "plane": "network",
            "point": {
              "x": 272,
              "y": 576,
            },
          },
          {
            "id": "junction:a-plus:network:internal_default:rail-east",
            "kind": "junction",
            "plane": "network",
            "point": {
              "x": 1196,
              "y": 318,
            },
          },
          {
            "id": "junction:a-plus:control:west",
            "kind": "junction",
            "plane": "control",
            "point": {
              "x": 300,
              "y": 258,
            },
          },
          {
            "id": "junction:a-plus:control:east",
            "kind": "junction",
            "plane": "control",
            "point": {
              "x": 1176,
              "y": 258,
            },
          },
          {
            "id": "via:a-plus:control:gateway:host-network",
            "kind": "via",
            "plane": "control",
            "point": {
              "x": 272,
              "y": 266,
            },
          },
          {
            "id": "junction:a-plus:control:fabric:gateway",
            "kind": "junction",
            "plane": "control",
            "point": {
              "x": 300,
              "y": 258,
            },
          },
          {
            "id": "junction:a-plus:control:service:qbittorrent",
            "kind": "junction",
            "plane": "control",
            "point": {
              "x": 366,
              "y": 258,
            },
          },
          {
            "id": "junction:a-plus:control:service:jellyfin",
            "kind": "junction",
            "plane": "control",
            "point": {
              "x": 884,
              "y": 258,
            },
          },
          {
            "id": "junction:a-plus:read:west",
            "kind": "junction",
            "plane": "read",
            "point": {
              "x": 272,
              "y": 548,
            },
          },
          {
            "id": "junction:a-plus:read:east",
            "kind": "junction",
            "plane": "read",
            "point": {
              "x": 1180,
              "y": 548,
            },
          },
          {
            "id": "junction:a-plus:read:service:qbittorrent",
            "kind": "junction",
            "plane": "read",
            "point": {
              "x": 416,
              "y": 548,
            },
          },
          {
            "id": "junction:a-plus:read:service:jellyfin",
            "kind": "junction",
            "plane": "read",
            "point": {
              "x": 760,
              "y": 548,
            },
          },
          {
            "id": "junction:a-plus:write:west",
            "kind": "junction",
            "plane": "write",
            "point": {
              "x": 260,
              "y": 574,
            },
          },
          {
            "id": "junction:a-plus:write:east",
            "kind": "junction",
            "plane": "write",
            "point": {
              "x": 1192,
              "y": 574,
            },
          },
          {
            "id": "via:a-plus:write:qbittorrent:read-substrate",
            "kind": "via",
            "plane": "write",
            "point": {
              "x": 280,
              "y": 548,
            },
          },
          {
            "id": "junction:a-plus:write:service:qbittorrent",
            "kind": "junction",
            "plane": "write",
            "point": {
              "x": 280,
              "y": 574,
            },
          },
          {
            "id": "junction:a-plus:control:service:seerr",
            "kind": "junction",
            "plane": "control",
            "point": {
              "x": 500,
              "y": 222,
            },
          },
          {
            "id": "junction:a-plus:control:service:sonarr",
            "kind": "junction",
            "plane": "control",
            "point": {
              "x": 804,
              "y": 222,
            },
          },
          {
            "id": "junction:a-plus:control:service:radarr",
            "kind": "junction",
            "plane": "control",
            "point": {
              "x": 1108,
              "y": 222,
            },
          },
          {
            "id": "junction:a-plus:control:orchestration-collector-west",
            "kind": "junction",
            "plane": "control",
            "point": {
              "x": 500,
              "y": 222,
            },
          },
          {
            "id": "junction:a-plus:control:orchestration-collector-east",
            "kind": "junction",
            "plane": "control",
            "point": {
              "x": 1108,
              "y": 222,
            },
          },
          {
            "id": "junction:a-plus:control:orchestration-approach-top",
            "kind": "junction",
            "plane": "control",
            "point": {
              "x": 560,
              "y": 222,
            },
          },
          {
            "id": "junction:a-plus:control:orchestration-approach-substrate",
            "kind": "junction",
            "plane": "control",
            "point": {
              "x": 560,
              "y": 258,
            },
          },
          {
            "id": "junction:a-plus:write:service:sonarr",
            "kind": "junction",
            "plane": "write",
            "point": {
              "x": 1184,
              "y": 226,
            },
          },
          {
            "id": "junction:a-plus:write:service:radarr",
            "kind": "junction",
            "plane": "write",
            "point": {
              "x": 1184,
              "y": 226,
            },
          },
          {
            "id": "junction:a-plus:write:orchestration-substrate",
            "kind": "junction",
            "plane": "write",
            "point": {
              "x": 1184,
              "y": 574,
            },
          },
          {
            "id": "via:a-plus:write:orchestration:jellyfin-network",
            "kind": "via",
            "plane": "write",
            "point": {
              "x": 1184,
              "y": 318,
            },
          },
          {
            "id": "junction:a-plus:read:service:sonarr",
            "kind": "junction",
            "plane": "read",
            "point": {
              "x": 620,
              "y": 222,
            },
          },
          {
            "id": "junction:a-plus:read:service:radarr",
            "kind": "junction",
            "plane": "read",
            "point": {
              "x": 620,
              "y": 222,
            },
          },
          {
            "id": "junction:a-plus:read:orchestration-substrate",
            "kind": "junction",
            "plane": "read",
            "point": {
              "x": 620,
              "y": 548,
            },
          },
          {
            "id": "via:a-plus:read:orchestration:control-substrate",
            "kind": "via",
            "plane": "read",
            "point": {
              "x": 620,
              "y": 258,
            },
          },
          {
            "id": "junction:a-plus:read:pool:DataStore",
            "kind": "junction",
            "plane": "read",
            "point": {
              "x": 367.8,
              "y": 670,
            },
          },
          {
            "id": "junction:a-plus:write:pool:DataStore",
            "kind": "junction",
            "plane": "write",
            "point": {
              "x": 465,
              "y": 664,
            },
          },
          {
            "id": "junction:a-plus:read:pool:NVME",
            "kind": "junction",
            "plane": "read",
            "point": {
              "x": 670.8,
              "y": 670,
            },
          },
          {
            "id": "junction:a-plus:write:pool:NVME",
            "kind": "junction",
            "plane": "write",
            "point": {
              "x": 768,
              "y": 664,
            },
          },
          {
            "id": "junction:a-plus:read:pool:eSATA",
            "kind": "junction",
            "plane": "read",
            "point": {
              "x": 1071,
              "y": 670,
            },
          },
          {
            "id": "junction:a-plus:write:pool:eSATA",
            "kind": "junction",
            "plane": "write",
            "point": {
              "x": 973.8,
              "y": 664,
            },
          },
          {
            "id": "junction:a-plus:read:storage-collector-west",
            "kind": "junction",
            "plane": "read",
            "point": {
              "x": 276,
              "y": 670,
            },
          },
          {
            "id": "junction:a-plus:write:storage-collector-east",
            "kind": "junction",
            "plane": "write",
            "point": {
              "x": 1192,
              "y": 664,
            },
          },
          {
            "id": "via:a-plus:read:storage-approach:write-substrate",
            "kind": "via",
            "plane": "read",
            "point": {
              "x": 276,
              "y": 574,
            },
          },
        ],
        "nodes": [
          {
            "bounds": {
              "height": 88,
              "width": 318,
              "x": 24,
              "y": 26,
            },
            "id": "resource:cpu",
            "ports": [],
          },
          {
            "bounds": {
              "height": 88,
              "width": 246,
              "x": 354,
              "y": 26,
            },
            "id": "resource:memory",
            "ports": [],
          },
          {
            "bounds": {
              "height": 88,
              "width": 302,
              "x": 612,
              "y": 26,
            },
            "id": "resource:gpu",
            "ports": [],
          },
          {
            "bounds": {
              "height": 88,
              "width": 250,
              "x": 926,
              "y": 26,
            },
            "id": "resource:arc",
            "ports": [],
          },
          {
            "bounds": {
              "height": 34,
              "width": 100,
              "x": 24,
              "y": 142,
            },
            "id": "external:wan",
            "ports": [
              {
                "center": {
                  "x": 124,
                  "y": 159,
                },
                "id": "external:wan:network",
                "kind": "network",
              },
            ],
          },
          {
            "bounds": {
              "height": 34,
              "width": 100,
              "x": 24,
              "y": 184,
            },
            "id": "external:lan",
            "ports": [
              {
                "center": {
                  "x": 124,
                  "y": 201,
                },
                "id": "external:lan:network",
                "kind": "network",
              },
            ],
          },
          {
            "bounds": {
              "height": 34,
              "width": 100,
              "x": 24,
              "y": 226,
            },
            "id": "external:overlay",
            "ports": [
              {
                "center": {
                  "x": 124,
                  "y": 243,
                },
                "id": "external:overlay:network",
                "kind": "network",
              },
            ],
          },
          {
            "bounds": {
              "height": 118,
              "width": 132,
              "x": 132,
              "y": 142,
            },
            "id": "fabric:gateway",
            "ports": [
              {
                "center": {
                  "x": 132,
                  "y": 159,
                },
                "id": "fabric:gateway:wan-network",
                "kind": "network",
              },
              {
                "center": {
                  "x": 132,
                  "y": 201,
                },
                "id": "fabric:gateway:lan-network",
                "kind": "network",
              },
              {
                "center": {
                  "x": 132,
                  "y": 243,
                },
                "id": "fabric:gateway:overlay-network",
                "kind": "network",
              },
              {
                "center": {
                  "x": 264,
                  "y": 247,
                },
                "id": "fabric:gateway:network",
                "kind": "network",
              },
              {
                "center": {
                  "x": 248,
                  "y": 260,
                },
                "id": "fabric:service:control",
                "kind": "control",
              },
            ],
          },
          {
            "bounds": {
              "height": 34,
              "width": 240,
              "x": 24,
              "y": 276,
            },
            "id": "network:other-docker-segments",
            "ports": [
              {
                "center": {
                  "x": 264,
                  "y": 293,
                },
                "id": "network:other-docker-segments:network",
                "kind": "network",
              },
            ],
          },
          {
            "bounds": {
              "height": 34,
              "width": 240,
              "x": 24,
              "y": 316,
            },
            "id": "network:bridge",
            "ports": [
              {
                "center": {
                  "x": 264,
                  "y": 333,
                },
                "id": "network:bridge:network",
                "kind": "network",
              },
            ],
          },
          {
            "bounds": {
              "height": 34,
              "width": 240,
              "x": 24,
              "y": 356,
            },
            "id": "network:internal_default",
            "ports": [
              {
                "center": {
                  "x": 264,
                  "y": 373,
                },
                "id": "network:internal_default:network",
                "kind": "network",
              },
            ],
          },
          {
            "bounds": {
              "height": 72,
              "width": 278,
              "x": 276,
              "y": 150,
            },
            "id": "service:seerr",
            "ports": [
              {
                "center": {
                  "x": 415,
                  "y": 150,
                },
                "id": "service:seerr:network",
                "kind": "network",
              },
              {
                "center": {
                  "x": 500,
                  "y": 222,
                },
                "id": "service:seerr:control",
                "kind": "control",
              },
            ],
          },
          {
            "bounds": {
              "height": 72,
              "width": 278,
              "x": 580,
              "y": 150,
            },
            "id": "service:sonarr",
            "ports": [
              {
                "center": {
                  "x": 719,
                  "y": 150,
                },
                "id": "service:sonarr:network",
                "kind": "network",
              },
              {
                "center": {
                  "x": 804,
                  "y": 222,
                },
                "id": "service:sonarr:control",
                "kind": "control",
              },
              {
                "center": {
                  "x": 616,
                  "y": 222,
                },
                "id": "service:sonarr:read",
                "kind": "read",
              },
              {
                "center": {
                  "x": 636,
                  "y": 222,
                },
                "id": "service:sonarr:write",
                "kind": "write",
              },
            ],
          },
          {
            "bounds": {
              "height": 72,
              "width": 278,
              "x": 884,
              "y": 150,
            },
            "id": "service:radarr",
            "ports": [
              {
                "center": {
                  "x": 1023,
                  "y": 150,
                },
                "id": "service:radarr:network",
                "kind": "network",
              },
              {
                "center": {
                  "x": 1108,
                  "y": 222,
                },
                "id": "service:radarr:control",
                "kind": "control",
              },
              {
                "center": {
                  "x": 966,
                  "y": 222,
                },
                "id": "service:radarr:read",
                "kind": "read",
              },
              {
                "center": {
                  "x": 978,
                  "y": 222,
                },
                "id": "service:radarr:write",
                "kind": "write",
              },
            ],
          },
          {
            "bounds": {
              "height": 116,
              "width": 300,
              "x": 300,
              "y": 294,
            },
            "id": "service:qbittorrent",
            "ports": [
              {
                "center": {
                  "x": 300,
                  "y": 318,
                },
                "id": "service:qbittorrent:network",
                "kind": "network",
              },
              {
                "center": {
                  "x": 366,
                  "y": 294,
                },
                "id": "service:qbittorrent:control",
                "kind": "control",
              },
              {
                "center": {
                  "x": 416,
                  "y": 410,
                },
                "id": "service:qbittorrent:read",
                "kind": "read",
              },
              {
                "center": {
                  "x": 400,
                  "y": 410,
                },
                "id": "service:qbittorrent:write",
                "kind": "write",
              },
            ],
          },
          {
            "bounds": {
              "height": 116,
              "width": 300,
              "x": 650,
              "y": 294,
            },
            "id": "service:jellyfin",
            "ports": [
              {
                "center": {
                  "x": 950,
                  "y": 318,
                },
                "id": "service:jellyfin:network",
                "kind": "network",
              },
              {
                "center": {
                  "x": 884,
                  "y": 294,
                },
                "id": "service:jellyfin:control",
                "kind": "control",
              },
              {
                "center": {
                  "x": 760,
                  "y": 410,
                },
                "id": "service:jellyfin:read",
                "kind": "read",
              },
            ],
          },
          {
            "bounds": {
              "height": 46,
              "width": 240,
              "x": 14,
              "y": 394,
            },
            "id": "group:platform",
            "ports": [
              {
                "center": {
                  "x": 254,
                  "y": 426,
                },
                "id": "group:platform:network",
                "kind": "network",
              },
            ],
          },
          {
            "bounds": {
              "height": 46,
              "width": 240,
              "x": 14,
              "y": 444,
            },
            "id": "group:media-support",
            "ports": [
              {
                "center": {
                  "x": 254,
                  "y": 476,
                },
                "id": "group:media-support:network",
                "kind": "network",
              },
            ],
          },
          {
            "bounds": {
              "height": 46,
              "width": 240,
              "x": 14,
              "y": 494,
            },
            "id": "group:observability",
            "ports": [
              {
                "center": {
                  "x": 254,
                  "y": 526,
                },
                "id": "group:observability:network",
                "kind": "network",
              },
            ],
          },
          {
            "bounds": {
              "height": 46,
              "width": 240,
              "x": 14,
              "y": 544,
            },
            "id": "group:network-edge",
            "ports": [
              {
                "center": {
                  "x": 254,
                  "y": 576,
                },
                "id": "group:network-edge:network",
                "kind": "network",
              },
            ],
          },
          {
            "bounds": {
              "height": 64,
              "width": 270,
              "x": 276,
              "y": 600,
            },
            "id": "pool:DataStore",
            "ports": [
              {
                "center": {
                  "x": 367.8,
                  "y": 664,
                },
                "id": "pool:DataStore:read",
                "kind": "read",
              },
              {
                "center": {
                  "x": 465,
                  "y": 664,
                },
                "id": "pool:DataStore:write",
                "kind": "write",
              },
            ],
          },
          {
            "bounds": {
              "height": 64,
              "width": 270,
              "x": 579,
              "y": 600,
            },
            "id": "pool:NVME",
            "ports": [
              {
                "center": {
                  "x": 670.8,
                  "y": 664,
                },
                "id": "pool:NVME:read",
                "kind": "read",
              },
              {
                "center": {
                  "x": 768,
                  "y": 664,
                },
                "id": "pool:NVME:write",
                "kind": "write",
              },
            ],
          },
          {
            "bounds": {
              "height": 64,
              "width": 270,
              "x": 882,
              "y": 600,
            },
            "id": "pool:eSATA",
            "ports": [
              {
                "center": {
                  "x": 1071,
                  "y": 664,
                },
                "id": "pool:eSATA:read",
                "kind": "read",
              },
              {
                "center": {
                  "x": 973.8,
                  "y": 664,
                },
                "id": "pool:eSATA:write",
                "kind": "write",
              },
            ],
          },
        ],
        "primaryStorageCorridors": [
          {
            "bounds": {
              "height": 164,
              "width": 154,
              "x": 388,
              "y": 410,
            },
            "nodeId": "service:qbittorrent",
          },
          {
            "bounds": {
              "height": 164,
              "width": 150,
              "x": 732,
              "y": 410,
            },
            "nodeId": "service:jellyfin",
          },
        ],
        "segments": [
          {
            "endpointIds": [
              "external:wan:network",
              "fabric:gateway:wan-network",
            ],
            "id": "segment:a-plus:wan-gateway",
            "junctionIds": [],
            "plane": "network",
            "points": [
              {
                "x": 124,
                "y": 159,
              },
              {
                "x": 132,
                "y": 159,
              },
            ],
          },
          {
            "endpointIds": [
              "external:lan:network",
              "fabric:gateway:lan-network",
            ],
            "id": "segment:a-plus:lan-gateway",
            "junctionIds": [],
            "plane": "network",
            "points": [
              {
                "x": 124,
                "y": 201,
              },
              {
                "x": 132,
                "y": 201,
              },
            ],
          },
          {
            "endpointIds": [
              "external:overlay:network",
              "fabric:gateway:overlay-network",
            ],
            "id": "segment:a-plus:overlay-gateway",
            "junctionIds": [],
            "plane": "network",
            "points": [
              {
                "x": 124,
                "y": 243,
              },
              {
                "x": 132,
                "y": 243,
              },
            ],
          },
          {
            "endpointIds": [
              "fabric:gateway:network",
              "junction:a-plus:host-network-root",
            ],
            "id": "segment:a-plus:gateway-network-root",
            "junctionIds": [
              "junction:a-plus:host-network-root",
            ],
            "plane": "network",
            "points": [
              {
                "x": 264,
                "y": 247,
              },
              {
                "x": 272,
                "y": 247,
              },
            ],
          },
          {
            "endpointIds": [
              "junction:a-plus:network:other-docker-segments:rail-root",
              "junction:a-plus:network:internal_default:host",
            ],
            "id": "segment:a-plus:host-network-trunk",
            "junctionIds": [
              "junction:a-plus:network:other-docker-segments:rail-root",
              "junction:a-plus:network:bridge:rail-root",
              "junction:a-plus:network:internal_default:rail-root",
              "junction:a-plus:host-network-root",
              "junction:a-plus:network:other-docker-segments:host",
              "junction:a-plus:network:bridge:host",
              "junction:a-plus:network:internal_default:host",
              "junction:a-plus:network:bridge:group:media-support",
              "junction:a-plus:network:internal_default:service:qbittorrent",
              "junction:a-plus:network:internal_default:group:platform",
              "junction:a-plus:network:internal_default:group:observability",
              "junction:a-plus:network:internal_default:group:network-edge",
            ],
            "plane": "network",
            "points": [
              {
                "x": 272,
                "y": 126,
              },
              {
                "x": 272,
                "y": 373,
              },
            ],
          },
          {
            "endpointIds": [
              "network:other-docker-segments:network",
              "junction:a-plus:network:other-docker-segments:host",
            ],
            "id": "segment:a-plus:network:other-docker-segments:gateway-branch",
            "junctionIds": [
              "junction:a-plus:network:other-docker-segments:host",
            ],
            "plane": "network",
            "points": [
              {
                "x": 264,
                "y": 293,
              },
              {
                "x": 272,
                "y": 293,
              },
            ],
          },
          {
            "endpointIds": [
              "junction:a-plus:network:other-docker-segments:rail-root",
              "junction:a-plus:network:other-docker-segments:rail-east",
            ],
            "id": "segment:a-plus:network:other-docker-segments:rail",
            "junctionIds": [
              "junction:a-plus:network:other-docker-segments:rail-root",
              "junction:a-plus:network:other-docker-segments:rail-east",
            ],
            "plane": "network",
            "points": [
              {
                "x": 272,
                "y": 126,
              },
              {
                "x": 356,
                "y": 126,
              },
            ],
          },
          {
            "endpointIds": [
              "network:bridge:network",
              "junction:a-plus:network:bridge:host",
            ],
            "id": "segment:a-plus:network:bridge:gateway-branch",
            "junctionIds": [
              "junction:a-plus:network:bridge:host",
            ],
            "plane": "network",
            "points": [
              {
                "x": 264,
                "y": 333,
              },
              {
                "x": 272,
                "y": 333,
              },
            ],
          },
          {
            "endpointIds": [
              "junction:a-plus:network:bridge:group:media-support",
              "group:media-support:network",
            ],
            "id": "segment:a-plus:network:bridge:group:media-support:network-branch",
            "junctionIds": [
              "junction:a-plus:network:bridge:group:media-support",
            ],
            "plane": "network",
            "points": [
              {
                "x": 272,
                "y": 476,
              },
              {
                "x": 254,
                "y": 476,
              },
            ],
          },
          {
            "endpointIds": [
              "junction:a-plus:network:bridge:rail-root",
              "junction:a-plus:network:bridge:rail-east",
            ],
            "id": "segment:a-plus:network:bridge:rail",
            "junctionIds": [
              "junction:a-plus:network:bridge:rail-root",
              "junction:a-plus:network:bridge:rail-east",
            ],
            "plane": "network",
            "points": [
              {
                "x": 272,
                "y": 134,
              },
              {
                "x": 1194,
                "y": 134,
              },
            ],
          },
          {
            "endpointIds": [
              "network:internal_default:network",
              "junction:a-plus:network:internal_default:host",
            ],
            "id": "segment:a-plus:network:internal_default:gateway-branch",
            "junctionIds": [
              "junction:a-plus:network:internal_default:host",
            ],
            "plane": "network",
            "points": [
              {
                "x": 264,
                "y": 373,
              },
              {
                "x": 272,
                "y": 373,
              },
            ],
          },
          {
            "endpointIds": [
              "junction:a-plus:network:internal_default:service:jellyfin",
              "service:jellyfin:network",
            ],
            "id": "segment:a-plus:network:internal_default:service:jellyfin:network-branch",
            "junctionIds": [
              "junction:a-plus:network:internal_default:service:jellyfin",
            ],
            "plane": "network",
            "points": [
              {
                "x": 1196,
                "y": 318,
              },
              {
                "x": 950,
                "y": 318,
              },
            ],
          },
          {
            "endpointIds": [
              "junction:a-plus:network:internal_default:service:qbittorrent",
              "service:qbittorrent:network",
            ],
            "id": "segment:a-plus:network:internal_default:service:qbittorrent:network-branch",
            "junctionIds": [
              "junction:a-plus:network:internal_default:service:qbittorrent",
            ],
            "plane": "network",
            "points": [
              {
                "x": 272,
                "y": 318,
              },
              {
                "x": 300,
                "y": 318,
              },
            ],
          },
          {
            "endpointIds": [
              "junction:a-plus:network:internal_default:service:sonarr",
              "service:sonarr:network",
            ],
            "id": "segment:a-plus:network:internal_default:service:sonarr:network-branch",
            "junctionIds": [
              "junction:a-plus:network:internal_default:service:sonarr",
            ],
            "plane": "network",
            "points": [
              {
                "x": 719,
                "y": 142,
              },
              {
                "x": 719,
                "y": 150,
              },
            ],
          },
          {
            "endpointIds": [
              "junction:a-plus:network:internal_default:service:radarr",
              "service:radarr:network",
            ],
            "id": "segment:a-plus:network:internal_default:service:radarr:network-branch",
            "junctionIds": [
              "junction:a-plus:network:internal_default:service:radarr",
            ],
            "plane": "network",
            "points": [
              {
                "x": 1023,
                "y": 142,
              },
              {
                "x": 1023,
                "y": 150,
              },
            ],
          },
          {
            "endpointIds": [
              "junction:a-plus:network:internal_default:service:seerr",
              "service:seerr:network",
            ],
            "id": "segment:a-plus:network:internal_default:service:seerr:network-branch",
            "junctionIds": [
              "junction:a-plus:network:internal_default:service:seerr",
            ],
            "plane": "network",
            "points": [
              {
                "x": 415,
                "y": 142,
              },
              {
                "x": 415,
                "y": 150,
              },
            ],
          },
          {
            "endpointIds": [
              "junction:a-plus:network:internal_default:group:platform",
              "group:platform:network",
            ],
            "id": "segment:a-plus:network:internal_default:group:platform:network-branch",
            "junctionIds": [
              "junction:a-plus:network:internal_default:group:platform",
            ],
            "plane": "network",
            "points": [
              {
                "x": 272,
                "y": 426,
              },
              {
                "x": 254,
                "y": 426,
              },
            ],
          },
          {
            "endpointIds": [
              "junction:a-plus:network:internal_default:group:observability",
              "group:observability:network",
            ],
            "id": "segment:a-plus:network:internal_default:group:observability:network-branch",
            "junctionIds": [
              "junction:a-plus:network:internal_default:group:observability",
            ],
            "plane": "network",
            "points": [
              {
                "x": 272,
                "y": 526,
              },
              {
                "x": 254,
                "y": 526,
              },
            ],
          },
          {
            "endpointIds": [
              "junction:a-plus:network:internal_default:group:network-edge",
              "group:network-edge:network",
            ],
            "id": "segment:a-plus:network:internal_default:group:network-edge:network-branch",
            "junctionIds": [
              "junction:a-plus:network:internal_default:group:network-edge",
            ],
            "plane": "network",
            "points": [
              {
                "x": 272,
                "y": 576,
              },
              {
                "x": 254,
                "y": 576,
              },
            ],
          },
          {
            "endpointIds": [
              "junction:a-plus:network:internal_default:rail-root",
              "junction:a-plus:network:internal_default:rail-east",
            ],
            "id": "segment:a-plus:network:internal_default:rail",
            "junctionIds": [
              "junction:a-plus:network:internal_default:rail-root",
              "junction:a-plus:network:internal_default:service:jellyfin",
              "junction:a-plus:network:internal_default:service:sonarr",
              "junction:a-plus:network:internal_default:service:radarr",
              "junction:a-plus:network:internal_default:service:seerr",
              "junction:a-plus:network:internal_default:rail-east",
            ],
            "plane": "network",
            "points": [
              {
                "x": 272,
                "y": 142,
              },
              {
                "x": 1196,
                "y": 142,
              },
              {
                "x": 1196,
                "y": 318,
              },
            ],
          },
          {
            "endpointIds": [
              "fabric:service:control",
              "junction:a-plus:control:fabric:gateway",
            ],
            "id": "segment:a-plus:control:fabric:gateway:branch",
            "junctionIds": [
              "junction:a-plus:control:fabric:gateway",
              "via:a-plus:control:gateway:host-network",
            ],
            "plane": "control",
            "points": [
              {
                "x": 248,
                "y": 260,
              },
              {
                "x": 248,
                "y": 266,
              },
              {
                "x": 300,
                "y": 266,
              },
              {
                "x": 300,
                "y": 258,
              },
            ],
          },
          {
            "endpointIds": [
              "service:qbittorrent:control",
              "junction:a-plus:control:service:qbittorrent",
            ],
            "id": "segment:a-plus:control:service:qbittorrent:branch",
            "junctionIds": [
              "junction:a-plus:control:service:qbittorrent",
            ],
            "plane": "control",
            "points": [
              {
                "x": 366,
                "y": 294,
              },
              {
                "x": 366,
                "y": 258,
              },
            ],
          },
          {
            "endpointIds": [
              "service:jellyfin:control",
              "junction:a-plus:control:service:jellyfin",
            ],
            "id": "segment:a-plus:control:service:jellyfin:branch",
            "junctionIds": [
              "junction:a-plus:control:service:jellyfin",
            ],
            "plane": "control",
            "points": [
              {
                "x": 884,
                "y": 294,
              },
              {
                "x": 884,
                "y": 258,
              },
            ],
          },
          {
            "endpointIds": [
              "junction:a-plus:control:west",
              "junction:a-plus:control:east",
            ],
            "id": "segment:a-plus:control:substrate",
            "junctionIds": [
              "junction:a-plus:control:west",
              "junction:a-plus:control:fabric:gateway",
              "junction:a-plus:control:service:qbittorrent",
              "junction:a-plus:control:service:jellyfin",
              "junction:a-plus:control:east",
              "junction:a-plus:control:orchestration-approach-substrate",
            ],
            "plane": "control",
            "points": [
              {
                "x": 300,
                "y": 258,
              },
              {
                "x": 1176,
                "y": 258,
              },
            ],
          },
          {
            "endpointIds": [
              "service:qbittorrent:read",
              "junction:a-plus:read:service:qbittorrent",
            ],
            "id": "segment:a-plus:read:service:qbittorrent:branch",
            "junctionIds": [
              "junction:a-plus:read:service:qbittorrent",
            ],
            "plane": "read",
            "points": [
              {
                "x": 416,
                "y": 410,
              },
              {
                "x": 416,
                "y": 548,
              },
            ],
          },
          {
            "endpointIds": [
              "service:jellyfin:read",
              "junction:a-plus:read:service:jellyfin",
            ],
            "id": "segment:a-plus:read:service:jellyfin:branch",
            "junctionIds": [
              "junction:a-plus:read:service:jellyfin",
            ],
            "plane": "read",
            "points": [
              {
                "x": 760,
                "y": 410,
              },
              {
                "x": 760,
                "y": 548,
              },
            ],
          },
          {
            "endpointIds": [
              "junction:a-plus:read:west",
              "junction:a-plus:read:east",
            ],
            "id": "segment:a-plus:read:substrate",
            "junctionIds": [
              "junction:a-plus:read:west",
              "junction:a-plus:read:service:qbittorrent",
              "junction:a-plus:read:service:jellyfin",
              "junction:a-plus:read:east",
              "junction:a-plus:read:orchestration-substrate",
            ],
            "plane": "read",
            "points": [
              {
                "x": 272,
                "y": 548,
              },
              {
                "x": 1180,
                "y": 548,
              },
            ],
          },
          {
            "endpointIds": [
              "service:qbittorrent:write",
              "junction:a-plus:write:service:qbittorrent",
            ],
            "id": "segment:a-plus:write:service:qbittorrent:branch",
            "junctionIds": [
              "junction:a-plus:write:service:qbittorrent",
              "via:a-plus:write:qbittorrent:read-substrate",
            ],
            "plane": "write",
            "points": [
              {
                "x": 400,
                "y": 410,
              },
              {
                "x": 280,
                "y": 410,
              },
              {
                "x": 280,
                "y": 574,
              },
            ],
          },
          {
            "endpointIds": [
              "junction:a-plus:write:west",
              "junction:a-plus:write:east",
            ],
            "id": "segment:a-plus:write:substrate",
            "junctionIds": [
              "junction:a-plus:write:west",
              "junction:a-plus:write:service:qbittorrent",
              "junction:a-plus:write:east",
              "junction:a-plus:write:orchestration-substrate",
            ],
            "plane": "write",
            "points": [
              {
                "x": 260,
                "y": 574,
              },
              {
                "x": 1192,
                "y": 574,
              },
            ],
          },
          {
            "endpointIds": [
              "service:seerr:control",
              "junction:a-plus:control:service:seerr",
            ],
            "id": "segment:a-plus:control:service:seerr:branch",
            "junctionIds": [
              "junction:a-plus:control:service:seerr",
            ],
            "plane": "control",
            "points": [
              {
                "x": 500,
                "y": 222,
              },
              {
                "x": 500,
                "y": 222,
              },
            ],
          },
          {
            "endpointIds": [
              "service:sonarr:control",
              "junction:a-plus:control:service:sonarr",
            ],
            "id": "segment:a-plus:control:service:sonarr:branch",
            "junctionIds": [
              "junction:a-plus:control:service:sonarr",
            ],
            "plane": "control",
            "points": [
              {
                "x": 804,
                "y": 222,
              },
              {
                "x": 804,
                "y": 222,
              },
            ],
          },
          {
            "endpointIds": [
              "service:radarr:control",
              "junction:a-plus:control:service:radarr",
            ],
            "id": "segment:a-plus:control:service:radarr:branch",
            "junctionIds": [
              "junction:a-plus:control:service:radarr",
            ],
            "plane": "control",
            "points": [
              {
                "x": 1108,
                "y": 222,
              },
              {
                "x": 1108,
                "y": 222,
              },
            ],
          },
          {
            "endpointIds": [
              "junction:a-plus:control:orchestration-collector-west",
              "junction:a-plus:control:orchestration-collector-east",
            ],
            "id": "segment:a-plus:control:orchestration-collector",
            "junctionIds": [
              "junction:a-plus:control:orchestration-collector-west",
              "junction:a-plus:control:service:seerr",
              "junction:a-plus:control:service:sonarr",
              "junction:a-plus:control:service:radarr",
              "junction:a-plus:control:orchestration-approach-top",
              "junction:a-plus:control:orchestration-collector-east",
            ],
            "plane": "control",
            "points": [
              {
                "x": 500,
                "y": 222,
              },
              {
                "x": 1108,
                "y": 222,
              },
            ],
          },
          {
            "endpointIds": [
              "junction:a-plus:control:orchestration-approach-top",
              "junction:a-plus:control:orchestration-approach-substrate",
            ],
            "id": "segment:a-plus:control:orchestration-approach",
            "junctionIds": [
              "junction:a-plus:control:orchestration-approach-top",
              "junction:a-plus:control:orchestration-approach-substrate",
            ],
            "plane": "control",
            "points": [
              {
                "x": 560,
                "y": 222,
              },
              {
                "x": 560,
                "y": 258,
              },
            ],
          },
          {
            "endpointIds": [
              "service:sonarr:write",
              "junction:a-plus:write:service:sonarr",
            ],
            "id": "segment:a-plus:write:service:sonarr:branch",
            "junctionIds": [
              "junction:a-plus:write:service:sonarr",
            ],
            "plane": "write",
            "points": [
              {
                "x": 636,
                "y": 222,
              },
              {
                "x": 636,
                "y": 226,
              },
              {
                "x": 1184,
                "y": 226,
              },
            ],
          },
          {
            "endpointIds": [
              "service:radarr:write",
              "junction:a-plus:write:service:radarr",
            ],
            "id": "segment:a-plus:write:service:radarr:branch",
            "junctionIds": [
              "junction:a-plus:write:service:radarr",
            ],
            "plane": "write",
            "points": [
              {
                "x": 978,
                "y": 222,
              },
              {
                "x": 978,
                "y": 226,
              },
              {
                "x": 1184,
                "y": 226,
              },
            ],
          },
          {
            "endpointIds": [
              "junction:a-plus:write:service:sonarr",
              "junction:a-plus:write:orchestration-substrate",
            ],
            "id": "segment:a-plus:write:orchestration-approach",
            "junctionIds": [
              "junction:a-plus:write:service:sonarr",
              "junction:a-plus:write:service:radarr",
              "junction:a-plus:write:orchestration-substrate",
              "via:a-plus:write:orchestration:jellyfin-network",
            ],
            "plane": "write",
            "points": [
              {
                "x": 1184,
                "y": 226,
              },
              {
                "x": 1184,
                "y": 574,
              },
            ],
          },
          {
            "endpointIds": [
              "service:sonarr:read",
              "junction:a-plus:read:service:sonarr",
            ],
            "id": "segment:a-plus:read:service:sonarr:branch",
            "junctionIds": [
              "junction:a-plus:read:service:sonarr",
            ],
            "plane": "read",
            "points": [
              {
                "x": 616,
                "y": 222,
              },
              {
                "x": 616,
                "y": 222,
              },
              {
                "x": 620,
                "y": 222,
              },
            ],
          },
          {
            "endpointIds": [
              "service:radarr:read",
              "junction:a-plus:read:service:radarr",
            ],
            "id": "segment:a-plus:read:service:radarr:branch",
            "junctionIds": [
              "junction:a-plus:read:service:radarr",
            ],
            "plane": "read",
            "points": [
              {
                "x": 966,
                "y": 222,
              },
              {
                "x": 966,
                "y": 222,
              },
              {
                "x": 620,
                "y": 222,
              },
            ],
          },
          {
            "endpointIds": [
              "junction:a-plus:read:service:sonarr",
              "junction:a-plus:read:orchestration-substrate",
            ],
            "id": "segment:a-plus:read:orchestration-approach",
            "junctionIds": [
              "junction:a-plus:read:service:sonarr",
              "junction:a-plus:read:service:radarr",
              "junction:a-plus:read:orchestration-substrate",
              "via:a-plus:read:orchestration:control-substrate",
            ],
            "plane": "read",
            "points": [
              {
                "x": 620,
                "y": 222,
              },
              {
                "x": 620,
                "y": 548,
              },
            ],
          },
          {
            "endpointIds": [
              "pool:DataStore:read",
              "junction:a-plus:read:pool:DataStore",
            ],
            "id": "segment:a-plus:read:pool:DataStore:branch",
            "junctionIds": [
              "junction:a-plus:read:pool:DataStore",
            ],
            "plane": "read",
            "points": [
              {
                "x": 367.8,
                "y": 664,
              },
              {
                "x": 367.8,
                "y": 670,
              },
            ],
          },
          {
            "endpointIds": [
              "pool:DataStore:write",
              "junction:a-plus:write:pool:DataStore",
            ],
            "id": "segment:a-plus:write:pool:DataStore:branch",
            "junctionIds": [
              "junction:a-plus:write:pool:DataStore",
            ],
            "plane": "write",
            "points": [
              {
                "x": 465,
                "y": 664,
              },
              {
                "x": 465,
                "y": 664,
              },
            ],
          },
          {
            "endpointIds": [
              "pool:NVME:read",
              "junction:a-plus:read:pool:NVME",
            ],
            "id": "segment:a-plus:read:pool:NVME:branch",
            "junctionIds": [
              "junction:a-plus:read:pool:NVME",
            ],
            "plane": "read",
            "points": [
              {
                "x": 670.8,
                "y": 664,
              },
              {
                "x": 670.8,
                "y": 670,
              },
            ],
          },
          {
            "endpointIds": [
              "pool:NVME:write",
              "junction:a-plus:write:pool:NVME",
            ],
            "id": "segment:a-plus:write:pool:NVME:branch",
            "junctionIds": [
              "junction:a-plus:write:pool:NVME",
            ],
            "plane": "write",
            "points": [
              {
                "x": 768,
                "y": 664,
              },
              {
                "x": 768,
                "y": 664,
              },
            ],
          },
          {
            "endpointIds": [
              "pool:eSATA:read",
              "junction:a-plus:read:pool:eSATA",
            ],
            "id": "segment:a-plus:read:pool:eSATA:branch",
            "junctionIds": [
              "junction:a-plus:read:pool:eSATA",
            ],
            "plane": "read",
            "points": [
              {
                "x": 1071,
                "y": 664,
              },
              {
                "x": 1071,
                "y": 670,
              },
            ],
          },
          {
            "endpointIds": [
              "pool:eSATA:write",
              "junction:a-plus:write:pool:eSATA",
            ],
            "id": "segment:a-plus:write:pool:eSATA:branch",
            "junctionIds": [
              "junction:a-plus:write:pool:eSATA",
            ],
            "plane": "write",
            "points": [
              {
                "x": 973.8,
                "y": 664,
              },
              {
                "x": 973.8,
                "y": 664,
              },
            ],
          },
          {
            "endpointIds": [
              "junction:a-plus:read:storage-collector-west",
              "junction:a-plus:read:pool:eSATA",
            ],
            "id": "segment:a-plus:read:storage-collector",
            "junctionIds": [
              "junction:a-plus:read:storage-collector-west",
              "junction:a-plus:read:pool:DataStore",
              "junction:a-plus:read:pool:NVME",
              "junction:a-plus:read:pool:eSATA",
            ],
            "plane": "read",
            "points": [
              {
                "x": 276,
                "y": 670,
              },
              {
                "x": 1071,
                "y": 670,
              },
            ],
          },
          {
            "endpointIds": [
              "junction:a-plus:write:pool:DataStore",
              "junction:a-plus:write:storage-collector-east",
            ],
            "id": "segment:a-plus:write:storage-collector",
            "junctionIds": [
              "junction:a-plus:write:pool:DataStore",
              "junction:a-plus:write:pool:NVME",
              "junction:a-plus:write:pool:eSATA",
              "junction:a-plus:write:storage-collector-east",
            ],
            "plane": "write",
            "points": [
              {
                "x": 465,
                "y": 664,
              },
              {
                "x": 1192,
                "y": 664,
              },
            ],
          },
          {
            "endpointIds": [
              "junction:a-plus:read:storage-collector-west",
              "junction:a-plus:read:west",
            ],
            "id": "segment:a-plus:read:storage-approach",
            "junctionIds": [
              "junction:a-plus:read:storage-collector-west",
              "via:a-plus:read:storage-approach:write-substrate",
              "junction:a-plus:read:west",
            ],
            "plane": "read",
            "points": [
              {
                "x": 276,
                "y": 670,
              },
              {
                "x": 276,
                "y": 548,
              },
              {
                "x": 272,
                "y": 548,
              },
            ],
          },
          {
            "endpointIds": [
              "junction:a-plus:write:storage-collector-east",
              "junction:a-plus:write:east",
            ],
            "id": "segment:a-plus:write:storage-approach",
            "junctionIds": [
              "junction:a-plus:write:storage-collector-east",
              "junction:a-plus:write:east",
            ],
            "plane": "write",
            "points": [
              {
                "x": 1192,
                "y": 664,
              },
              {
                "x": 1192,
                "y": 574,
              },
            ],
          },
        ],
      }
    `);
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

    const segmentIdsFor = (scene: ReturnType<typeof buildFabricComposition>, routeId: string) =>
      scene.logicalRoutes.find((route) => route.relationshipId === routeId)?.segmentIds ?? [];

    expect(segmentIdsFor(lanScene, "egress:jellyfin->network")).not.toContain("segment:a-plus:wan-gateway");
    expect(segmentIdsFor(lanScene, "egress:jellyfin->network:gateway-boundary:lan")).toEqual(["segment:a-plus:lan-gateway"]);
    expect(segmentIdsFor(overlayScene, "egress:jellyfin->network")).not.toContain("segment:a-plus:wan-gateway");
    expect(segmentIdsFor(overlayScene, "egress:jellyfin->network")).not.toContain("segment:a-plus:lan-gateway");
    expect(segmentIdsFor(overlayScene, "egress:jellyfin->network:gateway-boundary:overlay")).toEqual(["segment:a-plus:overlay-gateway"]);
    expect(segmentIdsFor(wanScene, "wan-transfer:network->qbittorrent:gateway-boundary:wan")).toEqual(["segment:a-plus:wan-gateway"]);
    expect(segmentIdsFor(internalScene, "declared:internal:sonarr->jellyfin")).not.toContain("segment:a-plus:wan-gateway");
    expect(segmentIdsFor(internalScene, "declared:internal:sonarr->jellyfin")).not.toContain("segment:a-plus:lan-gateway");
    expect(segmentIdsFor(internalScene, "declared:internal:sonarr->jellyfin")).not.toContain("segment:a-plus:overlay-gateway");
    expect(segmentIdsFor(unknownScene, "declared:unknown:jellyfin-network")).not.toContain("segment:a-plus:wan-gateway");
    expect(segmentIdsFor(unknownScene, "declared:unknown:jellyfin-network")).not.toContain("segment:a-plus:lan-gateway");
    expect(segmentIdsFor(unknownScene, "declared:unknown:jellyfin-network")).not.toContain("segment:a-plus:overlay-gateway");
    expect(lanScene.segments.map((segment) => segment.id)).toEqual(expect.arrayContaining([
      "segment:a-plus:wan-gateway",
      "segment:a-plus:lan-gateway",
      "segment:a-plus:overlay-gateway",
    ]));
  });

  it("models cross-pool import as separate continuous read and write operations", () => {
    const scene = buildFabricComposition(modelFor("cross-pool-import", { networkBoundaries: ["wan", "lan", "overlay"] }), "A+");
    const readOperation = scene.logicalRoutes.find((route) => route.relationshipId === "import-copy:pool:NVME->pool:DataStore:read-operation");
    const writeOperation = scene.logicalRoutes.find((route) => route.relationshipId === "import-copy:pool:NVME->pool:DataStore:write-operation");

    expect(readOperation).toBeDefined();
    expect(writeOperation).toBeDefined();
    expect(readOperation?.toPortId).toBe("service:sonarr:read");
    expect(writeOperation?.fromPortId).toBe("service:sonarr:write");
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
    expect(validation.viaCount).toBeLessThanOrEqual(6);
    expect(Object.values(validation.viaCountByRegion).every((count) => count <= 2)).toBe(true);
    expect(validation.undeclaredViaIds).toEqual([]);
    expect(validation.prohibitedViaIds).toEqual([]);
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

  it("keeps non-boundary endpoint branches stable when only the external boundary activity changes", () => {
    const lanScene = buildFabricComposition(modelFor("direct-play", {
      networkBoundaries: ["wan", "lan", "overlay"],
      networkBoundaryByFlowId: { "egress:jellyfin->network": "lan" },
    }), "A+");
    const overlayScene = buildFabricComposition(modelFor("direct-play", {
      networkBoundaries: ["wan", "lan", "overlay"],
      networkBoundaryByFlowId: { "egress:jellyfin->network": "overlay" },
    }), "A+");
    const wanScene = buildFabricComposition(modelFor("downloads", { networkBoundaries: ["wan", "lan", "overlay"] }), "A+");

    expect(routeFor(lanScene, "egress:jellyfin->network")?.segmentIds).toEqual([
      "segment:a-plus:network:internal_default:service:jellyfin:network-branch",
      "segment:a-plus:network:internal_default:rail",
      "segment:a-plus:host-network-trunk",
      "segment:a-plus:gateway-network-root",
    ]);
    expect(routeFor(overlayScene, "egress:jellyfin->network")?.segmentIds).toEqual(
      routeFor(lanScene, "egress:jellyfin->network")?.segmentIds,
    );
    expect(routeFor(wanScene, "wan-transfer:network->qbittorrent")?.segmentIds).toEqual([
      "segment:a-plus:gateway-network-root",
      "segment:a-plus:host-network-trunk",
      "segment:a-plus:network:internal_default:service:qbittorrent:network-branch",
    ]);
  });
});

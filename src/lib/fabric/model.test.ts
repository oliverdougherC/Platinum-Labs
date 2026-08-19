import { describe, expect, it } from "vitest";
import {
  buildFabricModel,
  buildFabricTopologyInventory,
  deriveFabricRenderedActivity,
} from "@/lib/fabric/model";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";
import { countRouteCrossings, countRouteOverlaps, expandBounds, routeHitsPorts, routeIntersectsBounds } from "@/lib/fabric/routing";

const NOW = Date.UTC(2026, 7, 15, 12);

describe("FabricModel", () => {
  it("terminates observed network traffic at the host gateway and models the external boundary separately", () => {
    const model = buildFabricModel(makeFakeSnapshot("downloads", NOW), { now: NOW, seerrConfigured: true });
    const wan = model.relationships.find((relationship) => relationship.id.startsWith("wan-transfer"));
    expect(wan).toBeDefined();
    expect([wan!.fromNodeId, wan!.toNodeId]).toContain("service:qbittorrent");
    expect([wan!.fromNodeId, wan!.toNodeId]).toContain("fabric:gateway");
    expect(model.relationships).toContainEqual(expect.objectContaining({
      id: expect.stringContaining("gateway-boundary"),
      fromNodeId: "external:wan",
      toNodeId: "fabric:gateway",
    }));
    expect(model.attachments.filter((attachment) => attachment.kind === "network").every((attachment) => attachment.fabricId.startsWith("network:"))).toBe(true);
    expect(model.nodes.some((node) => node.id.startsWith("network:") && node.eyebrow.includes("DOCKER NETWORK"))).toBe(true);
  });

  it("generates every route from the same visible connector registry", () => {
    const model = buildFabricModel(makeFakeSnapshot("active", NOW), { now: NOW, seerrConfigured: true });
    const ports = new Map(model.ports.map((port) => [port.id, port]));
    for (const relationship of model.relationships) {
      expect(routeHitsPorts(relationship.route, ports.get(relationship.fromPortId)!, ports.get(relationship.toPortId)!)).toBe(true);
    }
    for (const attachment of model.attachments) {
      expect(routeHitsPorts(attachment.route, ports.get(attachment.route.fromPortId)!, ports.get(attachment.route.toPortId)!)).toBe(true);
    }
  });

  it("keeps routed relationships outside every padded non-endpoint node and essential text box", () => {
    const model = buildFabricModel(makeFakeSnapshot("container-mixed", NOW), { now: NOW, seerrConfigured: true });
    for (const relationship of model.relationships) {
      for (const obstacle of model.routing.obstacles) {
        if (obstacle.id === relationship.fromNodeId || obstacle.id === relationship.toNodeId) continue;
        expect(
          routeIntersectsBounds(relationship.route, expandBounds(obstacle.bounds, obstacle.padding ?? 0)),
          `${relationship.id} intersects ${obstacle.id}`,
        ).toBe(false);
      }
    }
  });

  it("materializes only capability-specific service ports", () => {
    const model = buildFabricModel(makeFakeSnapshot("idle", NOW), { now: NOW, seerrConfigured: true });
    const requests = model.ports.filter((port) => port.nodeId === "service:seerr").map((port) => port.kind);
    expect(requests).toEqual(["network"]);
    for (const service of model.nodes.filter((node) => node.kind === "workload")) {
      const kinds = model.ports.filter((port) => port.nodeId === service.id).map((port) => port.kind);
      expect(new Set(kinds).size).toBe(kinds.length);
    }
  });

  it("bounds crossings and explains every shared segment with trunk metadata", () => {
    const model = buildFabricModel(makeFakeSnapshot("active", NOW), { now: NOW, seerrConfigured: true });
    let crossings = 0;
    for (let index = 0; index < model.relationships.length; index += 1) {
      for (let peerIndex = index + 1; peerIndex < model.relationships.length; peerIndex += 1) {
        const route = model.relationships[index]!.route;
        const peer = model.relationships[peerIndex]!.route;
        crossings += countRouteCrossings(route, [peer]);
        if (countRouteOverlaps(route, [peer]) > 0) {
          expect(
            route.segments?.some((segment) => segment.shared) || peer.segments?.some((segment) => segment.shared),
            `${model.relationships[index]!.id} overlaps ${model.relationships[peerIndex]!.id} without an explicit shared trunk`,
          ).toBe(true);
          expect(new Set([...(route.laneIds ?? []), ...(peer.laneIds ?? [])]).size).toBeGreaterThan(0);
        }
      }
    }
    expect(crossings).toBeLessThanOrEqual(1);
  });

  it("keeps control relationships thin, static, and free of byte rates", () => {
    const snapshot = makeFakeSnapshot("downloads", NOW);
    snapshot.fabricRelationships = [{ from: "service:sonarr", to: "service:jellyfin", kind: "control", label: "library refresh" }];
    const model = buildFabricModel(snapshot, { now: NOW, seerrConfigured: true });
    for (const relationship of model.relationships.filter((item) => item.plane === "control")) {
      expect(relationship.width).toBe(1);
      expect(relationship.animated).toBe(false);
      expect(relationship.rateBytesPerSecond).toBeNull();
      expect(relationship.tone).toBe("in");
    }
  });

  it("renders declared host control relationships and labels mixed endpoint types", () => {
    const snapshot = makeFakeSnapshot("idle", NOW);
    snapshot.fabricRelationships = [
      { from: "host:control", to: "service:sonarr", kind: "dependency" },
      { from: "pool:DataStore", to: "service:jellyfin", kind: "control" },
    ];
    const model = buildFabricModel(snapshot, { now: NOW, seerrConfigured: true });
    expect(model.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromNodeId: "fabric:service", toNodeId: "service:sonarr", label: "host control → sonarr", basis: "declared dependency" }),
      expect.objectContaining({ fromNodeId: "pool:DataStore", toNodeId: "service:jellyfin", label: "DataStore → jellyfin", basis: "declared control" }),
    ]));
  });

  it("uses configured and compose service identity for first-class network membership", () => {
    const snapshot = makeFakeSnapshot("container-field-real", NOW);
    const jellyfin = snapshot.telemetry.docker.value!.containers.find((item) => item.composeService === "jellyfin")!;
    jellyfin.name = "media-stack-jellyfin-1";
    snapshot.jellyfinContainer = "media-stack-jellyfin-1";
    const sonarr = snapshot.telemetry.docker.value!.containers.find((item) => item.composeService === "sonarr")!;
    sonarr.name = "media-stack-sonarr-1";
    const model = buildFabricModel(snapshot, { now: NOW, seerrConfigured: true });
    expect(model.attachments.find((item) => item.id === "attach:network:jellyfin:network:internal_default")).toMatchObject({ known: true, label: "internal_default" });
    expect(model.attachments.find((item) => item.id === "attach:network:sonarr:network:internal_default")).toMatchObject({ known: true, label: "internal_default" });
    expect(model.population.groups.flatMap((group) => group.members).some((item) => item.composeService === "jellyfin" || item.composeService === "sonarr")).toBe(false);
  });

  it("never animates stale or confirmed-zero relationships", () => {
    const stale = buildFabricModel(makeFakeSnapshot("stale", NOW), { now: NOW, seerrConfigured: true });
    expect(stale.relationships.every((relationship) => relationship.freshness !== "stale" || !relationship.animated)).toBe(true);
    expect(stale.relationships.every((relationship) => relationship.rateBytesPerSecond !== 0 || !relationship.animated)).toBe(true);
  });

  it("represents the entire real-scale container population", () => {
    const snapshot = makeFakeSnapshot("container-field-real", NOW);
    const model = buildFabricModel(snapshot, { now: NOW, seerrConfigured: true });
    expect(model.population.represented).toBe(snapshot.telemetry.docker.value!.containers.length);
    expect(model.population.ids).toHaveLength(44);
    const grouped = model.population.groups.reduce((sum, group) => sum + group.members.length, 0);
    const firstClass = snapshot.telemetry.docker.value!.containers.filter((container) => ["jellyfin", "sonarr", "radarr", "qbittorrent", "jellyseerr", "seerr"].includes(container.name.toLowerCase())).length;
    expect(grouped + firstClass).toBe(44);
    for (const group of model.population.groups) {
      expect(model.attachments.some((attachment) => attachment.nodeId === group.id && attachment.kind === "network")).toBe(true);
    }
  });

  it("renders resource accounting only as resource views, never relationships", () => {
    const model = buildFabricModel(makeFakeSnapshot("active", NOW), { now: NOW, seerrConfigured: true });
    expect(model.resourceViews.map((view) => view.id)).toEqual(["cpu", "memory", "gpu", "arc"]);
    expect(model.relationships.some((relationship) => relationship.fromNodeId.startsWith("resource:") || relationship.toNodeId.startsWith("resource:"))).toBe(false);
  });

  it("exposes first-class matched container accounting in cpu and memory resource views", () => {
    const snapshot = makeFakeSnapshot("container-field-real", NOW);
    const model = buildFabricModel(snapshot, { now: NOW, seerrConfigured: true });
    const jellyfin = snapshot.telemetry.docker.value!.containers.find((item) => item.composeService === "jellyfin")!;
    const cpu = model.resourceViews.find((view) => view.id === "cpu")!;
    const memory = model.resourceViews.find((view) => view.id === "memory")!;
    const accounted = model.population.accountedNodes.find((node) => node.nodeId === "service:jellyfin")!;
    const cpuContribution = cpu.contributors?.find((item) => item.nodeId === "service:jellyfin");
    const memoryContribution = memory.contributors?.find((item) => item.nodeId === "service:jellyfin");

    expect(accounted.containerIds).toEqual([jellyfin.stableId]);
    expect(accounted.accounting.cpuCores).toMatchObject({
      value: jellyfin.cpuFraction,
      coverage: "complete",
      completeContributors: 1,
      partialContributors: 0,
      unknownContributors: 0,
    });
    expect(accounted.accounting.memoryBytes).toMatchObject({
      value: jellyfin.memoryBytes,
      coverage: "complete",
      completeContributors: 1,
      partialContributors: 0,
      unknownContributors: 0,
    });
    expect(cpuContribution).toMatchObject({
      nodeId: "service:jellyfin",
      kind: "workload",
      value: jellyfin.cpuFraction,
      coverage: "complete",
    });
    expect(cpuContribution?.fraction).toBeCloseTo(
      jellyfin.cpuFraction! / snapshot.telemetry.cpu.value!.perCore.length,
      8,
    );
    expect(memoryContribution).toMatchObject({
      nodeId: "service:jellyfin",
      kind: "workload",
      value: jellyfin.memoryBytes,
      coverage: "complete",
    });
    expect(memoryContribution?.fraction).toBeCloseTo(
      jellyfin.memoryBytes! / snapshot.telemetry.memory.value!.totalBytes,
      8,
    );
  });

  it("aggregates grouped workload cpu memory and io with explicit lower-bound coverage", () => {
    const snapshot = makeFakeSnapshot("container-field-real", NOW);
    const model = buildFabricModel(snapshot, { now: NOW, seerrConfigured: true });
    const group = model.population.groups.find((item) => item.label === "Media support")!;
    const cpu = model.resourceViews.find((view) => view.id === "cpu")!;
    const memory = model.resourceViews.find((view) => view.id === "memory")!;
    const cpuExpected = group.members.reduce((sum, member) => sum + (member.cpuFraction ?? 0), 0);
    const memoryExpected = group.members.reduce((sum, member) => sum + (member.memoryBytes ?? 0), 0);
    const ioExpected = group.members.reduce(
      (sum, member) => sum + (member.blockReadBps ?? 0) + (member.blockWriteBps ?? 0),
      0,
    );
    const cpuUnknown = group.members.filter((member) => member.cpuFraction === null).length;
    const memoryUnknown = group.members.filter((member) => member.memoryBytes === null).length;
    const ioPartial = group.members.filter(
      (member) =>
        (member.blockReadBps === null) !== (member.blockWriteBps === null),
    ).length;
    const ioUnknown = group.members.filter(
      (member) => member.blockReadBps === null && member.blockWriteBps === null,
    ).length;

    expect(group.accounting.cpuCores.value).toBeCloseTo(cpuExpected, 5);
    expect(group.accounting.cpuCores.coverage).toBe("partial");
    expect(group.accounting.cpuCores.unknownContributors).toBe(cpuUnknown);
    expect(group.accounting.memoryBytes.value).toBe(memoryExpected);
    expect(group.accounting.memoryBytes.coverage).toBe("partial");
    expect(group.accounting.memoryBytes.unknownContributors).toBe(memoryUnknown);
    expect(group.accounting.ioBytesPerSecond.value).toBe(ioExpected);
    expect(group.accounting.ioBytesPerSecond.coverage).toBe("partial");
    expect(group.accounting.ioBytesPerSecond.partialContributors).toBe(ioPartial);
    expect(group.accounting.ioBytesPerSecond.unknownContributors).toBe(ioUnknown);
    expect(cpu.contributors?.find((item) => item.nodeId === group.id)).toMatchObject({
      value: group.accounting.cpuCores.value,
      coverage: "partial",
    });
    expect(memory.contributors?.find((item) => item.nodeId === group.id)).toMatchObject({
      value: group.accounting.memoryBytes.value,
      coverage: "partial",
    });
  });

  it("keeps group accounting unknown when no cpu memory or block io stats were sampled", () => {
    const snapshot = makeFakeSnapshot("container-field-real", NOW);
    for (const container of snapshot.telemetry.docker.value!.containers) {
      if (!/prowlarr|bazarr|sabnzbd|unpackerr|flaresolverr|gluetun|overseerr/.test(container.name.toLowerCase())) continue;
      if (["jellyfin", "qbittorrent", "sonarr", "radarr", "jellyseerr", "seerr"].includes(container.composeService ?? "")) continue;
      container.cpuFraction = null;
      container.memoryBytes = null;
      container.blockReadBps = null;
      container.blockWriteBps = null;
    }

    const model = buildFabricModel(snapshot, { now: NOW, seerrConfigured: true });
    const accounted = model.population.accountedNodes.find((node) => node.label === "Media support")!;
    const cpu = model.resourceViews.find((view) => view.id === "cpu")!;
    const memory = model.resourceViews.find((view) => view.id === "memory")!;

    expect(accounted.accounting.cpuCores).toMatchObject({
      value: null,
      coverage: "unknown",
      completeContributors: 0,
      partialContributors: 0,
      unknownContributors: accounted.containerIds.length,
    });
    expect(accounted.accounting.memoryBytes).toMatchObject({
      value: null,
      coverage: "unknown",
      completeContributors: 0,
      partialContributors: 0,
      unknownContributors: accounted.containerIds.length,
    });
    expect(accounted.accounting.ioBytesPerSecond).toMatchObject({
      value: null,
      coverage: "unknown",
      completeContributors: 0,
      partialContributors: 0,
      unknownContributors: accounted.containerIds.length,
    });
    expect(cpu.contributors?.find((item) => item.nodeId === "group:media-support")).toMatchObject({
      value: null,
      fraction: null,
      coverage: "unknown",
    });
    expect(memory.contributors?.find((item) => item.nodeId === "group:media-support")).toMatchObject({
      value: null,
      fraction: null,
      coverage: "unknown",
    });
  });

  it("attaches every named pool to separate shared read and write fabrics", () => {
    const model = buildFabricModel(makeFakeSnapshot("idle", NOW), { now: NOW, seerrConfigured: true });
    for (const node of model.nodes.filter((item) => item.kind === "storage" && item.id !== "pool:unmapped")) {
      const kinds = model.attachments.filter((item) => item.nodeId === node.id).map((item) => item.kind);
      expect(kinds).toContain("read");
      expect(kinds).toContain("write");
    }
  });

  it("shows cross-pool import copies but keeps same-pool imports as control-state only", () => {
    const samePool = buildFabricModel(makeFakeSnapshot("same-pool-import", NOW), { now: NOW, seerrConfigured: true });
    expect(samePool.relationships.some((item) => item.id.includes("import-copy"))).toBe(false);

    const crossPool = buildFabricModel(makeFakeSnapshot("cross-pool-import", NOW), { now: NOW, seerrConfigured: true });
    expect(crossPool.relationships.some((item) => item.id.includes("import-copy"))).toBe(true);
  });

  it("keeps stable capability defaults explicit for services pools and grouped workloads", () => {
    const model = buildFabricModel(makeFakeSnapshot("container-field-real", NOW), {
      now: NOW,
      seerrConfigured: true,
      networkBoundaries: ["wan", "lan", "overlay"],
    });

    expect(model.stableCapabilities).toMatchInlineSnapshot(`
      [
        {
          "control": true,
          "coverage": {
            "control": "complete",
            "network": "complete",
            "read": "complete",
            "write": "complete",
          },
          "network": true,
          "networkSegmentIds": [
            "network:internal_default",
            "network:media_default",
          ],
          "nodeId": "service:jellyfin",
          "read": true,
          "write": false,
        },
        {
          "control": true,
          "coverage": {
            "control": "complete",
            "network": "complete",
            "read": "complete",
            "write": "complete",
          },
          "network": true,
          "networkSegmentIds": [
            "network:internal_default",
            "network:media_default",
          ],
          "nodeId": "service:qbittorrent",
          "read": true,
          "write": true,
        },
        {
          "control": true,
          "coverage": {
            "control": "complete",
            "network": "complete",
            "read": "complete",
            "write": "complete",
          },
          "network": true,
          "networkSegmentIds": [
            "network:internal_default",
            "network:media_default",
          ],
          "nodeId": "service:sonarr",
          "read": true,
          "write": true,
        },
        {
          "control": true,
          "coverage": {
            "control": "complete",
            "network": "complete",
            "read": "complete",
            "write": "complete",
          },
          "network": true,
          "networkSegmentIds": [
            "network:internal_default",
            "network:media_default",
          ],
          "nodeId": "service:radarr",
          "read": true,
          "write": true,
        },
        {
          "control": true,
          "coverage": {
            "control": "complete",
            "network": "complete",
            "read": "complete",
            "write": "complete",
          },
          "network": true,
          "networkSegmentIds": [
            "network:internal_default",
            "network:media_default",
          ],
          "nodeId": "service:seerr",
          "read": false,
          "write": false,
        },
        {
          "control": false,
          "coverage": {
            "control": "complete",
            "network": "complete",
            "read": "complete",
            "write": "complete",
          },
          "network": false,
          "networkSegmentIds": [],
          "nodeId": "pool:DataStore",
          "read": true,
          "write": true,
        },
        {
          "control": false,
          "coverage": {
            "control": "complete",
            "network": "complete",
            "read": "complete",
            "write": "complete",
          },
          "network": false,
          "networkSegmentIds": [],
          "nodeId": "pool:NVME",
          "read": true,
          "write": true,
        },
        {
          "control": false,
          "coverage": {
            "control": "complete",
            "network": "complete",
            "read": "complete",
            "write": "complete",
          },
          "network": false,
          "networkSegmentIds": [],
          "nodeId": "pool:eSATA",
          "read": true,
          "write": true,
        },
        {
          "control": false,
          "coverage": {
            "control": "unknown",
            "network": "complete",
            "read": "unknown",
            "write": "unknown",
          },
          "network": true,
          "networkSegmentIds": [
            "network:internal_default",
            "network:media_default",
            "network:observability_default",
          ],
          "nodeId": "group:platform",
          "read": false,
          "write": false,
        },
        {
          "control": false,
          "coverage": {
            "control": "unknown",
            "network": "complete",
            "read": "unknown",
            "write": "unknown",
          },
          "network": true,
          "networkSegmentIds": [
            "network:bridge",
            "network:internal_default",
            "network:media_default",
          ],
          "nodeId": "group:media-support",
          "read": false,
          "write": false,
        },
        {
          "control": false,
          "coverage": {
            "control": "unknown",
            "network": "complete",
            "read": "unknown",
            "write": "unknown",
          },
          "network": true,
          "networkSegmentIds": [
            "network:internal_default",
            "network:observability_default",
          ],
          "nodeId": "group:observability",
          "read": false,
          "write": false,
        },
        {
          "control": false,
          "coverage": {
            "control": "unknown",
            "network": "complete",
            "read": "unknown",
            "write": "unknown",
          },
          "network": true,
          "networkSegmentIds": [
            "network:internal_default",
          ],
          "nodeId": "group:network-edge",
          "read": false,
          "write": false,
        },
      ]
    `);
  });

  it("refines optional control capability from stable configuration without treating missing proof as false coverage", () => {
    const unconfigured = makeFakeSnapshot("idle", NOW);
    unconfigured.health = unconfigured.health.map((connector) =>
      connector.id === "jellyfin" || connector.id === "qbittorrent"
        ? { ...connector, configured: false }
        : connector,
    );
    const unconfiguredModel = buildFabricModel(unconfigured, { now: NOW, seerrConfigured: true });

    for (const nodeId of ["service:jellyfin", "service:qbittorrent"]) {
      expect(unconfiguredModel.stableCapabilities.find((capability) => capability.nodeId === nodeId)).toMatchObject({
        control: false,
        coverage: { control: "unknown" },
      });
    }

    const declared = structuredClone(unconfigured);
    declared.fabricRelationships = [
      { from: "service:jellyfin", to: "service:qbittorrent", kind: "control" },
      { from: "pool:DataStore", to: "service:jellyfin", kind: "control" },
    ];
    const declaredModel = buildFabricModel(declared, { now: NOW, seerrConfigured: true });
    for (const nodeId of ["service:jellyfin", "service:qbittorrent", "pool:DataStore"]) {
      expect(declaredModel.stableCapabilities.find((capability) => capability.nodeId === nodeId)).toMatchObject({
        control: true,
        coverage: { control: "complete" },
      });
    }
  });

  it("derives every rendered activity state deterministically", () => {
    expect(deriveFabricRenderedActivity({
      plane: "data",
      evidence: "measured",
      freshness: "live",
      coverage: "complete",
      rateBytesPerSecond: 1,
    })).toBe("live-transfer");
    expect(deriveFabricRenderedActivity({
      plane: "control",
      evidence: "state-only",
      freshness: "live",
      coverage: "unknown",
      rateBytesPerSecond: null,
    })).toBe("live-state-only");
    expect(deriveFabricRenderedActivity({
      plane: "data",
      evidence: "derived",
      freshness: "stale",
      coverage: "complete",
      rateBytesPerSecond: 2,
    })).toBe("stale");
    expect(deriveFabricRenderedActivity({
      plane: "data",
      evidence: "measured",
      freshness: "live",
      coverage: "complete",
      rateBytesPerSecond: 0,
    })).toBe("confirmed-zero");
    expect(deriveFabricRenderedActivity({
      plane: "data",
      evidence: "reported",
      freshness: "unknown",
      coverage: "unknown",
      rateBytesPerSecond: null,
    })).toBe("unknown");
    expect(deriveFabricRenderedActivity({
      plane: "control",
      evidence: "reported",
      freshness: "live",
      coverage: "complete",
      rateBytesPerSecond: null,
      focus: true,
    })).toBe("dormant");
  });

  it("renders honest confirmed-zero acquisition relationships without motion", () => {
    const snapshot = makeFakeSnapshot("downloads", NOW);
    snapshot.acquisition.items = snapshot.acquisition.items.filter((item) => item.source === "sonarr");
    snapshot.acquisition.rollup = {
      ...snapshot.acquisition.rollup,
      aggregateRateBps: 0,
      uploadRateBps: 0,
      seeding: 0,
    };

    const model = buildFabricModel(snapshot, { now: NOW, seerrConfigured: true });
    const wan = model.relationships.find((relationship) => relationship.id === "wan-transfer:network->qbittorrent")!;
    const storage = model.relationships.find((relationship) => relationship.id === "storage-transfer:qbittorrent->pool:NVME")!;

    expect(wan).toMatchObject({
      renderedActivity: "confirmed-zero",
      rateBytesPerSecond: 0,
      animated: false,
      controllerServiceId: "sonarr",
    });
    expect(storage).toMatchObject({
      renderedActivity: "confirmed-zero",
      rateBytesPerSecond: 0,
      animated: false,
      controllerServiceId: "sonarr",
    });
  });

  it("copies typed controller attribution onto derived relationships", () => {
    const snapshot = makeFakeSnapshot("downloads", NOW);
    snapshot.acquisition.items = snapshot.acquisition.items.filter((item) => item.source === "sonarr");

    const model = buildFabricModel(snapshot, { now: NOW, seerrConfigured: true });

    expect(model.relationships.find((relationship) => relationship.id === "storage-transfer:qbittorrent->pool:NVME")).toMatchObject({
      controllerServiceId: "sonarr",
    });
    expect(model.relationships.find((relationship) => relationship.id === "control:sonarr->qbittorrent")).toMatchObject({
      controllerServiceId: "sonarr",
    });
    expect(model.relationships.find((relationship) => relationship.id === "import-copy:pool:NVME->pool:DataStore")).toMatchObject({
      controllerServiceId: "sonarr",
    });
  });

  it("builds sanitized topology inventory and reuses it during Docker outage without inventing runtime stats", () => {
    const live = makeFakeSnapshot("container-field-real", NOW);
    const inventory = buildFabricTopologyInventory(live);
    const outage = {
      ...live,
      telemetry: {
        ...live.telemetry,
        docker: {
          status: "unavailable" as const,
          updatedAt: null,
          value: null,
        },
      },
    };

    const coldStart = buildFabricModel(outage, { now: NOW, seerrConfigured: true });
    const recovered = buildFabricModel(outage, { now: NOW, seerrConfigured: true, inventory });
    const liveModel = buildFabricModel(live, { now: NOW, seerrConfigured: true });

    expect(inventory.groups[0]).toEqual(expect.objectContaining({
      source: "live",
      freshness: "live",
      members: expect.any(Array),
    }));
    expect(Object.keys(inventory.groups[0]!.members[0]!).sort()).toEqual([
      "composeService",
      "id",
      "networkNames",
      "networkSegmentIds",
    ]);

    expect(coldStart.nodes.some((node) => node.id.startsWith("network:"))).toBe(false);
    expect(coldStart.nodes.some((node) => node.kind === "group")).toBe(false);

    expect(recovered.nodes.filter((node) => node.id.startsWith("network:")).map((node) => node.id)).toEqual([
      "network:bridge",
      "network:internal_default",
      "network:other-docker-segments",
    ]);
    expect(recovered.networkSegments.map((network) => network.id)).toEqual(
      inventory.networks.map((network) => network.id),
    );
    expect(recovered.nodes.some((node) => node.id === "group:media-support")).toBe(true);
    expect(recovered.attachments.find((attachment) => attachment.id === "attach:network:jellyfin:network:internal_default")).toMatchObject({
      known: true,
    });
    expect(recovered.stableCapabilities.find((capability) => capability.nodeId === "service:jellyfin")?.networkSegmentIds).toEqual(
      liveModel.stableCapabilities.find((capability) => capability.nodeId === "service:jellyfin")?.networkSegmentIds,
    );
    expect(recovered.population.represented).toBe(44);
    expect(recovered.population.running).toBeNull();
    expect(recovered.population.ids).toHaveLength(44);
    expect(recovered.population.accountedNodes.find((node) => node.nodeId === "service:jellyfin")).toMatchObject({
      containerIds: [],
      accounting: {
        cpuCores: { value: null, coverage: "unknown" },
        memoryBytes: { value: null, coverage: "unknown" },
      },
    });
  });

  it("fans out one network attachment per resolved membership segment for services and groups", () => {
    const live = makeFakeSnapshot("container-field-real", NOW);
    const inventory = buildFabricTopologyInventory(live);
    const outage = {
      ...live,
      telemetry: {
        ...live.telemetry,
        docker: {
          status: "unavailable" as const,
          updatedAt: null,
          value: null,
        },
      },
    };

    const model = buildFabricModel(outage, { now: NOW, seerrConfigured: true, inventory });
    const jellyfinAttachments = model.attachments.filter((attachment) => attachment.nodeId === "service:jellyfin" && attachment.kind === "network");
    const sonarrAttachments = model.attachments.filter((attachment) => attachment.nodeId === "service:sonarr" && attachment.kind === "network");
    const mediaSupportAttachments = model.attachments.filter((attachment) => attachment.nodeId === "group:media-support" && attachment.kind === "network");

    expect(jellyfinAttachments.map((attachment) => attachment.fabricId).sort()).toEqual([
      "network:internal_default",
      "network:other-docker-segments",
    ]);
    expect(jellyfinAttachments.map((attachment) => attachment.id).sort()).toEqual([
      "attach:network:jellyfin:network:internal_default",
      "attach:network:jellyfin:network:media_default",
    ]);
    expect(jellyfinAttachments.map((attachment) => attachment.label).sort()).toEqual([
      "internal_default",
      "media_default",
    ]);
    expect(sonarrAttachments.map((attachment) => attachment.fabricId).sort()).toEqual([
      "network:internal_default",
      "network:other-docker-segments",
    ]);
    expect(sonarrAttachments.map((attachment) => attachment.id).sort()).toEqual([
      "attach:network:sonarr:network:internal_default",
      "attach:network:sonarr:network:media_default",
    ]);
    expect(mediaSupportAttachments.map((attachment) => attachment.fabricId).sort()).toEqual([
      "network:bridge",
      "network:internal_default",
      "network:other-docker-segments",
    ]);
    expect(mediaSupportAttachments.map((attachment) => attachment.id).sort()).toEqual([
      "attach:network:group:media-support:network:bridge",
      "attach:network:group:media-support:network:internal_default",
      "attach:network:group:media-support:network:media_default",
    ]);
  });
});

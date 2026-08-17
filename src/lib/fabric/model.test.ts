import { describe, expect, it } from "vitest";
import { buildFabricModel } from "@/lib/fabric/model";
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
    expect(model.attachments.find((item) => item.id === "attach:network:jellyfin")).toMatchObject({ known: true, label: expect.stringContaining("media_default") });
    expect(model.attachments.find((item) => item.id === "attach:network:sonarr")).toMatchObject({ known: true, label: expect.stringContaining("media_default") });
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
});

import { describe, expect, it } from "vitest";
import { buildFabricModel } from "@/lib/fabric/model";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";
import { routeHitsPorts } from "@/lib/fabric/routing";

const NOW = Date.UTC(2026, 7, 15, 12);

describe("FabricModel", () => {
  it("terminates observed network traffic at a shared host fabric", () => {
    const model = buildFabricModel(makeFakeSnapshot("downloads", NOW), { now: NOW, seerrConfigured: true });
    const wan = model.relationships.find((relationship) => relationship.id.startsWith("wan-transfer"));
    expect(wan).toBeDefined();
    expect([wan!.fromNodeId, wan!.toNodeId]).toContain("service:qbittorrent");
    expect([wan!.fromNodeId, wan!.toNodeId].some((id) => id.startsWith("fabric:external"))).toBe(true);
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
      expect.objectContaining({ fromNodeId: "fabric:service", toNodeId: "service:sonarr", label: "host control → sonarr" }),
      expect.objectContaining({ fromNodeId: "pool:DataStore", toNodeId: "service:jellyfin", label: "DataStore → jellyfin" }),
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

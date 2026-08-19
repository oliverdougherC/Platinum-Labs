"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FabricComposition,
  FabricCompositionIncomplete,
  type FabricCompositionViewMode,
  type FabricTopologyState,
} from "@/components/fabric/fabric-composition";
import {
  buildFabricModel,
  buildFabricTopologyInventory,
  type FabricTopologyInventory,
} from "@/lib/fabric/model";
import type { DashboardSnapshot } from "@/lib/types";

const FABRIC_AMBIENT_SAMPLE_MS = 10_000;

interface FabricSnapshotInput {
  snapshot: DashboardSnapshot;
  now: number;
  storyKey: string;
}

function fabricOperationalStoryKey(snapshot: DashboardSnapshot): string {
  const containers = snapshot.telemetry.docker.value?.containers ?? [];
  return JSON.stringify({
    mode: snapshot.mode,
    configuration: {
      mediaPool: snapshot.mediaPool ?? null,
      downloadPool: snapshot.downloadPool ?? null,
      jellyfinContainer: snapshot.jellyfinContainer ?? null,
      networkLinkBytesPerSecond: snapshot.networkLinkBytesPerSecond ?? null,
    },
    health: snapshot.health.map(({ id, status, configured, configError }) => ({ id, status, configured, configError })),
    telemetryStatus: Object.fromEntries(
      Object.entries(snapshot.telemetry).map(([domain, value]) => [domain, value.status]),
    ),
    containerStory: containers.map((container) => ({
      id: container.stableId ?? container.name,
      name: container.name,
      composeProject: container.composeProject ?? null,
      composeService: container.composeService ?? null,
      networkNames: [...(container.networkNames ?? [])].sort(),
      state: container.state,
      health: container.health,
      restartCount: container.restartCount,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    playback: {
      serverAvailable: snapshot.jellyfin.serverAvailable,
      sessions: snapshot.jellyfin.sessions.map((session) => ({
        id: session.id,
        user: session.user,
        title: session.title,
        subtitle: session.subtitle,
        method: session.method,
        paused: session.paused,
        resolution: session.resolution,
      })).sort((left, right) => left.id.localeCompare(right.id)),
    },
    acquisition: {
      items: snapshot.acquisition.items.map((item) => ({
        id: item.id,
        source: item.source,
        title: item.title,
        quality: item.quality,
        state: item.state,
        correlationKey: item.correlationKey ?? null,
      })).sort((left, right) => left.id.localeCompare(right.id)),
      downloading: snapshot.acquisition.rollup.downloading,
      importing: snapshot.acquisition.rollup.importing,
      failedOrStalled: snapshot.acquisition.rollup.failedOrStalled,
      seeding: snapshot.acquisition.rollup.seeding ?? null,
    },
    storage: snapshot.zfs.pools.map((pool) => ({
      name: pool.name,
      health: pool.health,
      scan: pool.scan,
      scrubErrors: pool.scrubErrors,
    })).sort((left, right) => left.name.localeCompare(right.name)),
    declaredRelationships: [...(snapshot.fabricRelationships ?? [])]
      .map(({ from, to, kind, label }) => ({ from, to, kind, label: label ?? null }))
      .sort((left, right) => `${left.from}:${left.to}:${left.kind}`.localeCompare(`${right.from}:${right.to}:${right.kind}`)),
    attention: snapshot.attention.map(({ alertId, severity, source, subject, resolvedAt }) => ({
      alertId,
      severity,
      source,
      subject: subject ?? null,
      resolvedAt: resolvedAt ?? null,
    })).sort((left, right) => left.alertId.localeCompare(right.alertId)),
    resourceShape: {
      cpuCount: snapshot.telemetry.cpu.value?.perCore.length ?? null,
      memoryTotal: snapshot.telemetry.memory.value?.totalBytes ?? null,
      gpuName: snapshot.telemetry.gpu.value?.name ?? null,
      gpuMemoryTotal: snapshot.telemetry.gpu.value?.vramTotalBytes ?? null,
      networkInterfaces: [...(snapshot.telemetry.network.value?.interfaces ?? [])].sort(),
      diskPools: [...(snapshot.telemetry.disk.value?.pools.map((pool) => pool.pool) ?? [])].sort(),
    },
  });
}

function useSampledFabricInput(snapshot: DashboardSnapshot, now: number, frozen: boolean): FabricSnapshotInput {
  const storyKey = useMemo(() => fabricOperationalStoryKey(snapshot), [snapshot]);
  const latest = useMemo(() => ({ snapshot, now, storyKey }), [now, snapshot, storyKey]);
  const latestRef = useRef(latest);
  latestRef.current = latest;
  const [promoted, setPromoted] = useState<FabricSnapshotInput>(latest);
  const promotedRef = useRef(promoted);
  const pendingRef = useRef<FabricSnapshotInput | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPromotionAtRef = useRef(Date.now());

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);
  const promote = useCallback((next: FabricSnapshotInput) => {
    clearTimer();
    pendingRef.current = null;
    lastPromotionAtRef.current = Date.now();
    promotedRef.current = next;
    setPromoted((current) =>
      current.snapshot === next.snapshot && current.now === next.now ? current : next,
    );
  }, [clearTimer]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) {
        clearTimer();
        pendingRef.current = latestRef.current;
        return;
      }
      if (!frozen && pendingRef.current) promote(pendingRef.current);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [clearTimer, frozen, promote]);

  useEffect(() => {
    if (frozen) {
      promote(latest);
      return;
    }
    if (document.hidden) {
      clearTimer();
      pendingRef.current = latest;
      return;
    }
    if (storyKey !== promotedRef.current.storyKey) {
      promote(latest);
      return;
    }
    if (latest.snapshot === promotedRef.current.snapshot && latest.now === promotedRef.current.now) {
      pendingRef.current = null;
      return;
    }
    pendingRef.current = latest;
    if (timerRef.current !== null) return;
    const elapsed = Date.now() - lastPromotionAtRef.current;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (!document.hidden && pendingRef.current) promote(pendingRef.current);
    }, Math.max(0, FABRIC_AMBIENT_SAMPLE_MS - elapsed));
  }, [clearTimer, frozen, latest, promote, storyKey]);

  useEffect(() => clearTimer, [clearTimer]);
  return frozen ? latest : promoted;
}

function fabricGeometryKey(inventory: FabricTopologyInventory, model: ReturnType<typeof buildFabricModel>): string {
  return JSON.stringify({
    inventory: {
      workloads: inventory.workloads.map(({ nodeId, serviceId, containerIds, networkNames, networkSegmentIds }) => ({
        nodeId,
        serviceId,
        containerIds,
        networkNames,
        networkSegmentIds,
      })),
      groups: inventory.groups.map(({ id, label, members, networkNames, networkSegmentIds }) => ({
        id,
        label,
        members,
        networkNames,
        networkSegmentIds,
      })),
      networks: inventory.networks.map(({ id, names, label, count, displayGroupId }) => ({
        id,
        names,
        label,
        count,
        displayGroupId,
      })),
      pools: inventory.pools.map(({ id, name, label, generic }) => ({ id, name, label, generic })),
    },
    relationships: model.relationships.map((relationship) => ({
      id: relationship.id,
      fromNodeId: relationship.fromNodeId,
      toNodeId: relationship.toNodeId,
      fromPortId: relationship.fromPortId,
      toPortId: relationship.toPortId,
      plane: relationship.plane,
      networkBoundary: relationship.networkBoundary,
      controllerServiceId: (relationship as typeof relationship & { controllerServiceId?: string }).controllerServiceId ?? null,
    })).sort((left, right) => left.id.localeCompare(right.id)),
  });
}

export function FabricApp({
  snapshot,
  now,
  seerrConfigured,
  frozen,
  reducedMotion,
  devControls,
}: {
  snapshot: DashboardSnapshot;
  now: number;
  seerrConfigured: boolean;
  frozen: boolean;
  reducedMotion: boolean;
  devControls: boolean;
}) {
  const sampled = useSampledFabricInput(snapshot, now, frozen);
  const sampledSnapshot = sampled.snapshot;
  const sampledNow = sampled.now;
  const lastKnownTopology = useRef<FabricTopologyInventory | null>(null);
  const currentTopology = useMemo(() => buildFabricTopologyInventory(sampledSnapshot), [sampledSnapshot]);
  const dockerStatus = sampledSnapshot.telemetry.docker.status;
  const hasCurrentDockerTopology =
    (dockerStatus === "available" || dockerStatus === "stale") &&
    (sampledSnapshot.telemetry.docker.value?.containers.length ?? 0) > 0;
  if (hasCurrentDockerTopology) lastKnownTopology.current = currentTopology;
  const retainedTopology = hasCurrentDockerTopology ? currentTopology : lastKnownTopology.current;
  const topologyState: FabricTopologyState = hasCurrentDockerTopology
    ? "live"
    : retainedTopology
      ? "last-known"
      : "incomplete";
  const model = useMemo(() => buildFabricModel(sampledSnapshot, {
    now: sampledNow,
    seerrConfigured,
    networkBoundaries: ["wan", "lan", "overlay"],
    inventory: retainedTopology,
  }), [sampledSnapshot, sampledNow, seerrConfigured, retainedTopology]);
  const geometryKey = useMemo(
    () => retainedTopology ? fabricGeometryKey(retainedTopology, model) : "incomplete",
    [model, retainedTopology],
  );
  const geometryModelCache = useRef<{ key: string; model: typeof model } | null>(null);
  if (geometryModelCache.current?.key !== geometryKey) {
    geometryModelCache.current = { key: geometryKey, model };
  }
  const geometryModel = geometryModelCache.current.model;
  const [viewMode, setViewMode] = useState<FabricCompositionViewMode>("activity");
  const [pageVisible, setPageVisible] = useState(true);

  useEffect(() => {
    const relationshipMap = new URLSearchParams(window.location.search).get("relationships") === "1";
    setViewMode(relationshipMap ? "relationship-map" : "activity");
  }, [devControls]);

  useEffect(() => {
    const syncVisibility = () => setPageVisible(!document.hidden);
    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    return () => document.removeEventListener("visibilitychange", syncVisibility);
  }, []);

  if (topologyState === "incomplete") return <FabricCompositionIncomplete />;

  return (
    <FabricComposition
      model={model}
      geometryModel={geometryModel}
      study="A+"
      viewMode={viewMode}
      quiet={model.relationships.every((relationship) => relationship.visibility !== "active")}
      motionEnabled={!frozen && !reducedMotion && pageVisible}
      topologyState={topologyState}
    />
  );
}

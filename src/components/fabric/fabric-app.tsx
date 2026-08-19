"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  const lastKnownTopology = useRef<FabricTopologyInventory | null>(null);
  const currentTopology = useMemo(() => buildFabricTopologyInventory(snapshot), [snapshot]);
  const dockerStatus = snapshot.telemetry.docker.status;
  const hasCurrentDockerTopology =
    (dockerStatus === "available" || dockerStatus === "stale") &&
    (snapshot.telemetry.docker.value?.containers.length ?? 0) > 0;
  if (hasCurrentDockerTopology) lastKnownTopology.current = currentTopology;
  const retainedTopology = hasCurrentDockerTopology ? currentTopology : lastKnownTopology.current;
  const topologyState: FabricTopologyState = hasCurrentDockerTopology
    ? "live"
    : retainedTopology
      ? "last-known"
      : "incomplete";
  const model = useMemo(() => buildFabricModel(snapshot, {
    now,
    seerrConfigured,
    networkBoundaries: ["wan", "lan", "overlay"],
    inventory: retainedTopology,
  }), [snapshot, now, seerrConfigured, retainedTopology]);
  const [viewMode, setViewMode] = useState<FabricCompositionViewMode>("activity");

  useEffect(() => {
    const relationshipMap = new URLSearchParams(window.location.search).get("relationships") === "1";
    setViewMode(relationshipMap ? "relationship-map" : "activity");
  }, [devControls]);

  if (topologyState === "incomplete") return <FabricCompositionIncomplete />;

  return (
    <FabricComposition
      model={model}
      study="A+"
      viewMode={viewMode}
      quiet={model.relationships.every((relationship) => relationship.visibility !== "active")}
      motionEnabled={!frozen && !reducedMotion}
      topologyState={topologyState}
    />
  );
}

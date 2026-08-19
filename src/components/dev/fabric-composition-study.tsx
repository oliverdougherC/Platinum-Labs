"use client";

import { useEffect, useMemo, useState } from "react";
import {
  FabricComposition,
  type FabricCompositionViewMode,
} from "@/components/fabric/fabric-composition";
import { makeFakeSnapshot, isScenario, type FakeScenario } from "@/lib/fake/snapshot";
import {
  buildFabricModel,
  buildFabricTopologyInventory,
} from "@/lib/fabric/model";

export { resolveStudyRelationshipState } from "@/components/fabric/fabric-composition";

const STUDY_INVENTORY_NOW = Date.UTC(2026, 7, 15, 12, 0, 0);
const STUDY_TOPOLOGY_INVENTORY = buildFabricTopologyInventory(
  makeFakeSnapshot("container-field-real", STUDY_INVENTORY_NOW),
);

export function FabricCompositionStudy({
  initialScenario,
  initialViewMode,
  now,
  initialFocus,
}: {
  initialScenario: FakeScenario;
  initialViewMode: FabricCompositionViewMode;
  now: number;
  initialFocus: string | null;
}) {
  const [scenario, setScenario] = useState(initialScenario);
  useEffect(() => setScenario(initialScenario), [initialScenario]);
  const [viewMode, setViewMode] = useState(initialViewMode);
  useEffect(() => setViewMode(initialViewMode), [initialViewMode]);
  const mapMode = viewMode === "relationship-map";

  const model = useMemo(() => {
    const activitySnapshot = makeFakeSnapshot(scenario, now);
    const relationshipMapSnapshot = makeFakeSnapshot("relationship-map", now);
    const snapshot = {
      ...activitySnapshot,
      fabricRelationships: mapMode
        ? relationshipMapSnapshot.fabricRelationships
        : activitySnapshot.fabricRelationships,
    };
    return buildFabricModel(snapshot, {
      now,
      seerrConfigured: true,
      networkBoundaries: ["wan", "lan", "overlay"],
      inventory: STUDY_TOPOLOGY_INVENTORY,
    });
  }, [mapMode, now, scenario]);

  useEffect(() => {
    const devWindow = window as Window & {
      __homelabSetScenario?: (next: string) => void;
      __homelabSetStudyMode?: (next: string) => void;
    };
    devWindow.__homelabSetScenario = (next) => {
      if (isScenario(next)) setScenario(next);
    };
    devWindow.__homelabSetStudyMode = (next) => {
      setViewMode(next === "relationship-map" ? "relationship-map" : "activity");
    };
    return () => {
      delete devWindow.__homelabSetScenario;
      delete devWindow.__homelabSetStudyMode;
    };
  }, []);

  return (
    <FabricComposition
      model={model}
      study="A+"
      viewMode={viewMode}
      quiet={scenario === "idle"}
      initialFocus={initialFocus}
      motionEnabled
      surfaceLabel="V3 composition study"
    />
  );
}

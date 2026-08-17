"use client";

import { useEffect, useMemo, useState } from "react";
import { FabricInspector } from "@/components/fabric/fabric-inspector";
import { FabricStage, type FabricSelection } from "@/components/fabric/fabric-stage";
import { buildFabricModel } from "@/lib/fabric/model";
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
  const model = useMemo(() => buildFabricModel(snapshot, { now, seerrConfigured }), [snapshot, now, seerrConfigured]);
  const [selection, setSelection] = useState<FabricSelection | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [relationshipsVisible, setRelationshipsVisible] = useState(false);

  useEffect(() => {
    if (!devControls) return;
    setRelationshipsVisible(new URLSearchParams(window.location.search).get("relationships") === "1");
  }, [devControls]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || detailsOpen) return;
      setSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailsOpen]);

  return (
    <div data-fabric-mount data-ui-mode="fabric" className="fabric-ground relative h-full w-full overflow-hidden">
      <div className="pointer-events-none absolute left-4 top-3 z-10 flex items-center gap-3 text-[9px] uppercase tracking-[0.16em] text-faint">
        <span>Server fabric</span>
        <span className="h-px w-6 bg-hairline" />
        <span className="tnum">{model.population.represented}/{model.population.total ?? "—"} workloads</span>
        {relationshipsVisible ? <span className="text-muted">relationship map</span> : null}
      </div>
      <FabricStage
        model={model}
        selection={selection}
        onSelect={(next) => setSelection((current) => current?.kind === next.kind && current.id === next.id ? null : next)}
        relationshipsVisible={relationshipsVisible}
        motionEnabled={!frozen && !reducedMotion}
      />
      <FabricInspector
        model={model}
        selection={selection}
        onClose={() => setSelection(null)}
        detailsOpen={detailsOpen}
        onDetailsOpen={() => setDetailsOpen(true)}
        onDetailsClose={() => setDetailsOpen(false)}
      />
    </div>
  );
}

"use client";

/**
 * V4 production shell adapter: mounts the SAME KineticCanvas the dev
 * reference surface uses (one implementation, no production copy that can
 * drift) on top of the real live snapshot pipeline that TopologyApp already
 * owns — SSE transport, polling fallback, connector health, normalized
 * telemetry, notifications, request media, and the command palette.
 *
 * Its one added responsibility is persistent last-known identity: when
 * Docker telemetry drops out, the workload field keeps the last-known
 * container population as explicit UNKNOWNS (dashed rings, no stats) instead
 * of vanishing — retained identity, never retained liveness. Runtime numbers
 * are stripped so a stale CPU figure can never render as current truth.
 */

import { useMemo, useRef } from "react";
import { KineticCanvas } from "@/components/kinetic/kinetic-canvas";
import type { DashboardSnapshot, DockerTelemetry } from "@/lib/types";

function retainedIdentity(last: DockerTelemetry): DockerTelemetry {
  return {
    total: last.total,
    running: 0,
    healthy: 0,
    unhealthy: 0,
    restarting: 0,
    containers: last.containers.map((container) => ({
      name: container.name,
      stableId: container.stableId ?? null,
      composeProject: container.composeProject ?? null,
      composeService: container.composeService ?? null,
      networkNames: container.networkNames ?? [],
      state: "unknown",
      health: null,
      restartCount: null,
      cpuFraction: null,
      memoryBytes: container.memoryBytes, // last-known footprint sizes the cell
      netRxBps: null,
      netTxBps: null,
      blockReadBps: null,
      blockWriteBps: null,
    })),
  };
}

export function KineticApp({
  snapshot,
  now,
  seerrConfigured,
  frozen,
  devControls,
}: {
  snapshot: DashboardSnapshot;
  now: number;
  seerrConfigured: boolean;
  frozen: boolean;
  devControls: boolean;
}) {
  const lastKnownDocker = useRef<DockerTelemetry | null>(null);
  const docker = snapshot.telemetry.docker;
  const hasCurrent =
    (docker.status === "available" || docker.status === "stale") &&
    (docker.value?.containers.length ?? 0) > 0;
  if (hasCurrent) lastKnownDocker.current = docker.value ?? null;

  const effective = useMemo<DashboardSnapshot>(() => {
    if (hasCurrent || !lastKnownDocker.current) return snapshot;
    return {
      ...snapshot,
      telemetry: {
        ...snapshot.telemetry,
        docker: {
          ...snapshot.telemetry.docker,
          value: retainedIdentity(lastKnownDocker.current),
        },
      },
    };
  }, [snapshot, hasCurrent]);

  return (
    <KineticCanvas
      snapshot={effective}
      now={now}
      seerrConfigured={seerrConfigured}
      frozen={frozen}
      surfaceLabel="Kinetic flow canvas"
      debugHook={devControls}
    />
  );
}

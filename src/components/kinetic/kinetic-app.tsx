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
import type {
  DashboardSnapshot,
  DockerContainerTelemetry,
  DockerTelemetry,
} from "@/lib/types";

function unknownIdentity(container: DockerContainerTelemetry): DockerContainerTelemetry {
  return {
    name: container.name,
    stableId: container.stableId ?? null,
    composeProject: container.composeProject ?? null,
    composeService: container.composeService ?? null,
    networkNames: container.networkNames ?? [],
    state: "unknown",
    health: null,
    restartCount: null,
    cpuFraction: null,
    memoryBytes: container.memoryBytes,
    netRxBps: null,
    netTxBps: null,
    blockReadBps: null,
    blockWriteBps: null,
  };
}

function containerIdentity(container: DockerContainerTelemetry): string {
  return container.stableId ?? `${container.composeProject ?? ""}:${container.composeService ?? ""}:${container.name}`;
}

function retainedIdentity(last: DockerTelemetry): DockerTelemetry {
  return {
    total: last.total,
    running: 0,
    healthy: 0,
    unhealthy: 0,
    restarting: 0,
    containers: last.containers.map(unknownIdentity),
  };
}

interface RetainedContainer {
  container: DockerContainerTelemetry;
  missingSamples: number;
}

export function retainSingleMissingSample(
  current: DockerTelemetry,
  previous: ReadonlyMap<string, RetainedContainer>,
): { docker: DockerTelemetry; retained: Map<string, RetainedContainer> } {
  const retained = new Map<string, RetainedContainer>();
  const containers = [...current.containers];
  const present = new Set<string>();
  for (const container of current.containers) {
    const id = containerIdentity(container);
    present.add(id);
    retained.set(id, { container, missingSamples: 0 });
  }
  for (const [id, entry] of previous) {
    if (present.has(id) || entry.missingSamples >= 1) continue;
    const unknown = unknownIdentity(entry.container);
    containers.push(unknown);
    retained.set(id, { container: unknown, missingSamples: entry.missingSamples + 1 });
  }
  return { docker: { ...current, containers }, retained };
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
  const retainedContainers = useRef(new Map<string, RetainedContainer>());
  const docker = snapshot.telemetry.docker;
  const hasCurrent =
    (docker.status === "available" || docker.status === "stale") &&
    (docker.value?.containers.length ?? 0) > 0;
  let currentDocker = docker.value;
  if (hasCurrent && currentDocker) {
    const reconciled = retainSingleMissingSample(currentDocker, retainedContainers.current);
    currentDocker = reconciled.docker;
    retainedContainers.current = reconciled.retained;
    lastKnownDocker.current = currentDocker;
  }

  const effective = useMemo<DashboardSnapshot>(() => {
    if (hasCurrent && currentDocker) {
      return {
        ...snapshot,
        telemetry: {
          ...snapshot.telemetry,
          docker: { ...snapshot.telemetry.docker, value: currentDocker },
        },
      };
    }
    if (!lastKnownDocker.current) return snapshot;
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
  }, [snapshot, hasCurrent, currentDocker]);

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

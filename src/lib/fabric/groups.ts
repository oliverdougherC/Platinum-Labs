import type { DockerContainerTelemetry } from "@/lib/types";

export type FabricAccountingCoverage = "complete" | "partial" | "unknown";

export interface FabricAccountingAggregate {
  value: number | null;
  coverage: FabricAccountingCoverage;
  completeContributors: number;
  partialContributors: number;
  unknownContributors: number;
}

export interface FabricAccountingRollup {
  cpuCores: FabricAccountingAggregate;
  memoryBytes: FabricAccountingAggregate;
  ioBytesPerSecond: FabricAccountingAggregate;
}

export interface FabricGroupMember extends DockerContainerTelemetry {
  id: string;
  attention: boolean;
  metricCoverage: FabricAccountingCoverage;
}

export interface FabricWorkloadGroup {
  id: string;
  label: string;
  members: FabricGroupMember[];
  attentionCount: number;
  accounting: FabricAccountingRollup;
}

const FIRST_CLASS = new Set([
  "jellyfin",
  "sonarr",
  "radarr",
  "qbittorrent",
  "jellyseerr",
  "seerr",
]);

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "other";
}

function fallbackGroup(name: string): string {
  const lower = name.toLowerCase();
  if (/grafana|prometheus|loki|dozzle|uptime|scrutiny|alert/.test(lower)) return "Observability";
  if (/prowlarr|bazarr|sabnzbd|unpackerr|flaresolverr|gluetun|overseerr/.test(lower)) return "Media support";
  if (/proxy|nginx|traefik|cloudflare|tailscale|auth|dns/.test(lower)) return "Network edge";
  return "Platform";
}

function coverage(container: DockerContainerTelemetry): FabricGroupMember["metricCoverage"] {
  const values = [
    container.cpuFraction,
    container.memoryBytes,
    container.netRxBps,
    container.netTxBps,
    container.blockReadBps,
    container.blockWriteBps,
  ];
  const known = values.filter((value) => value !== null).length;
  return known === 0 ? "unknown" : known === values.length ? "complete" : "partial";
}

interface FabricMetricContribution {
  value: number | null;
  coverage: FabricAccountingCoverage;
}

function completeContribution(value: number | null): FabricMetricContribution {
  return value === null ? { value: null, coverage: "unknown" } : { value, coverage: "complete" };
}

function ioContribution(container: DockerContainerTelemetry): FabricMetricContribution {
  const values = [container.blockReadBps, container.blockWriteBps].filter(
    (value): value is number => typeof value === "number",
  );
  if (values.length === 0) return { value: null, coverage: "unknown" };
  return {
    value: values.reduce((sum, value) => sum + value, 0),
    coverage: values.length === 2 ? "complete" : "partial",
  };
}

function aggregateContributions(contributions: FabricMetricContribution[]): FabricAccountingAggregate {
  let value = 0;
  let completeContributors = 0;
  let partialContributors = 0;
  let unknownContributors = 0;

  for (const contribution of contributions) {
    if (contribution.coverage === "unknown" || contribution.value === null) {
      unknownContributors += 1;
      continue;
    }
    value += contribution.value;
    if (contribution.coverage === "complete") completeContributors += 1;
    else partialContributors += 1;
  }

  const knownContributors = completeContributors + partialContributors;
  return {
    value: knownContributors > 0 ? value : null,
    coverage: knownContributors === 0
      ? "unknown"
      : unknownContributors === 0 && partialContributors === 0
      ? "complete"
      : "partial",
    completeContributors,
    partialContributors,
    unknownContributors,
  };
}

export function accountingForContainers(containers: DockerContainerTelemetry[]): FabricAccountingRollup {
  return {
    cpuCores: aggregateContributions(containers.map((container) => completeContribution(container.cpuFraction))),
    memoryBytes: aggregateContributions(containers.map((container) => completeContribution(container.memoryBytes))),
    ioBytesPerSecond: aggregateContributions(containers.map(ioContribution)),
  };
}

function member(container: DockerContainerTelemetry): FabricGroupMember {
  const attention =
    container.health === "unhealthy" ||
    container.state === "restarting" ||
    (container.state !== "running" && container.state !== "unknown");
  return {
    ...container,
    id: container.stableId ?? `name-${safeId(container.name)}`,
    attention,
    metricCoverage: coverage(container),
  };
}

function groupKey(container: DockerContainerTelemetry): string {
  return fallbackGroup(`${container.name} ${container.composeService ?? ""}`);
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Stable four-bank grouping. Extra projects merge explicitly into Other. */
export function groupWorkloads(containers: DockerContainerTelemetry[]): FabricWorkloadGroup[] {
  const buckets = new Map<string, FabricGroupMember[]>();
  for (const container of containers) {
    if (
      FIRST_CLASS.has(container.name.toLowerCase()) ||
      FIRST_CLASS.has(container.composeService?.toLowerCase() ?? "")
    ) continue;
    const key = groupKey(container);
    const existing = buckets.get(key) ?? [];
    existing.push(member(container));
    buckets.set(key, existing);
  }

  const ordered = [...buckets.entries()]
    .map(([label, members]) => ({ label, members }))
    .sort((a, b) => b.members.length - a.members.length || compareText(a.label, b.label));
  const kept = ordered.slice(0, 4);
  const merged = ordered.slice(4).flatMap((group) => group.members);
  if (merged.length) kept.push({ label: "Other workloads", members: merged });

  return kept.map(({ label, members }) => {
    members.sort((a, b) =>
      Number(b.attention) - Number(a.attention) ||
      Number(a.metricCoverage === "unknown") - Number(b.metricCoverage === "unknown") ||
      compareText(a.name, b.name),
    );
    return {
      id: `group:${safeId(label)}`,
      label,
      members,
      attentionCount: members.filter((item) => item.attention).length,
      accounting: accountingForContainers(members),
    };
  });
}

/**
 * V4 Kinetic Flow Canvas — scene view model (PLA: V4 redesign).
 *
 * Pure projection of the normalized DashboardSnapshot into what the kinetic
 * renderer draws. No pixels here: the layout module assigns geometry and the
 * painter assigns light. Every field is grounded in the existing truth model
 * (buildSceneModel / deriveFlows / groupWorkloads) and preserves the V3
 * invariants: null is never zero, stale freezes, unavailable suppresses,
 * control never carries bytes, storage identity is declared not inferred.
 */

import type { DashboardSnapshot, CpuTopology } from "@/lib/types";
import {
  buildSceneModel,
  type BodyStatus,
  type DockerContainerModel,
  type SceneModel,
  type StorageBodyModel,
} from "@/lib/scene/model";
import {
  classifyFlowRate,
  flowNetworkBoundary,
  isAuthoritativeZero,
  resolveJellyfinPlayback,
  type FlowKind,
  type FlowNetworkBoundary,
  type FlowObservation,
  primaryRate,
} from "@/lib/topology/activity";
import { groupWorkloads } from "@/lib/fabric/groups";
import { formatBytes, formatRate } from "@/lib/format/bytes";

// --- instrument band ----------------------------------------------------------

export interface CpuInstrument {
  status: "available" | "stale" | "unavailable" | "not-configured";
  /**
   * One value per rendered cell. With detected topology each cell is a
   * PHYSICAL core showing the mean utilization of its sibling threads;
   * without topology each cell is a logical CPU (labeled accordingly).
   */
  cells: number[];
  cellKind: "physical-core" | "logical-cpu";
  /** "44C / 88T" when topology is known, "32T" style otherwise, null unknown. */
  topologyLabel: string | null;
  totalFraction: number | null;
  load1: number | null;
}

export interface GaugeInstrument {
  status: "available" | "stale" | "unavailable" | "not-configured";
  /** 0..1 fill, null when unknown. */
  fraction: number | null;
  primary: string | null;
  secondary: string | null;
}

export interface InstrumentModel {
  cpu: CpuInstrument;
  memory: GaugeInstrument;
  gpu: GaugeInstrument & { name: string | null; vramFraction: number | null };
  arc: GaugeInstrument;
}

// --- bodies --------------------------------------------------------------------

export interface AnchorModel {
  id: "qbittorrent" | "jellyfin";
  label: string;
  status: BodyStatus;
  active: boolean;
  /** Short activity line: "2 downloading", "streaming · 1 paused". */
  headline: string | null;
  /** Real rates only, e.g. "↓ 84.2 MB/s · ↑ 1.1 MB/s". Null when unknown. */
  rateLine: string | null;
  /** 0..1 luminous energy for the canvas pool under the anchor. */
  glow: number;
  /** Resource contribution for the inspector, formatted lazily by the UI. */
  cpuCores: number | null;
  memoryBytes: number | null;
}

export interface OrchestratorModel {
  id: "sonarr" | "radarr";
  label: string;
  status: BodyStatus;
  active: boolean;
  detail: string | null;
}

export interface EdgeAnchorModel {
  id: "wan" | "clients";
  labels: string[];
  side: "left" | "right";
  /** True while a live flow terminates here. */
  active: boolean;
}

export interface FieldCellModel {
  id: string;
  name: string;
  /** 0..1 memory-driven size score. */
  sizeScore: number;
  /** 0..1 CPU-driven brightness; null CPU renders as the unknown treatment. */
  intensity: number | null;
  /** 0..1 network/block I/O halo. */
  ioHalo: number;
  attention: boolean;
  unverified: boolean;
  running: boolean;
  /** Labels appear only for attention or materially active cells. */
  labelVisible: boolean;
  cpuFraction: number | null;
  memoryBytes: number | null;
}

export interface FieldGroupModel {
  id: string;
  label: string;
  cells: FieldCellModel[];
  attentionCount: number;
}

export interface StorageStratumModel {
  name: string;
  role: "media" | "download" | "other";
  capacityFraction: number;
  capacityTone: "ok" | "warn" | "critical";
  usedLabel: string;
  totalLabel: string;
  totalBytes: number;
  healthy: boolean;
  healthLabel: string;
  scrubbing: boolean;
  /** Live activity for the wake treatment; null = unknown, 0 = confirmed calm. */
  readBps: number | null;
  writeBps: number | null;
  ioFreshness: "live" | "stale" | "unavailable";
  capacityBasis: "logical" | "pool-allocation";
}

// --- flows ----------------------------------------------------------------------

export type FlowTreatment =
  /** Real measured/derived byte movement: ribbon + particles. */
  | "particles"
  /**
   * Active work whose TOTAL rate is unknown — including a partial known-zero
   * (a 0 B/s lower bound with unknown contributors): minimal ribbon, slow
   * breath, no particles, no throughput claim.
   */
  | "state-only"
  /** Last-known work, frozen: static ribbon, desaturated, no motion. */
  | "stale"
  /** Confirmed zero: hairline presence only, nothing animates. */
  | "confirmed-zero";

export type KineticNodeRef =
  | { kind: "edge"; id: "wan" | "clients" }
  | { kind: "anchor"; id: "qbittorrent" | "jellyfin" }
  | { kind: "orchestrator"; id: "sonarr" | "radarr" }
  | { kind: "pool"; name: string }
  | { kind: "storage" };

export interface KineticFlowChannel {
  /** forward = from → to. */
  direction: "forward" | "reverse";
  bytesPerSecond: number | null;
}

export interface KineticFlow {
  id: string;
  kind: FlowKind;
  from: KineticNodeRef;
  to: KineticNodeRef;
  treatment: FlowTreatment;
  tone: "in" | "out" | "import" | "control";
  /** Headline rate (max known channel), null for control/state-only. */
  rateBps: number | null;
  channels: KineticFlowChannel[];
  /** Typed network-boundary truth for flows that touch an external edge. */
  boundary: FlowNetworkBoundary;
  label: string;
  provenance: string;
}

// --- scene -----------------------------------------------------------------------

export interface AttentionSummaryModel {
  critical: number;
  warning: number;
  headline: string | null;
}

export interface KineticScene {
  demo: boolean;
  hostLabel: string;
  instrument: InstrumentModel;
  anchors: AnchorModel[];
  orchestration: OrchestratorModel[];
  edges: EdgeAnchorModel[];
  field: FieldGroupModel[];
  fieldTotal: number | null;
  fieldRunning: number | null;
  storage: StorageStratumModel[];
  flows: KineticFlow[];
  attention: AttentionSummaryModel;
  critical: boolean;
}

export interface KineticSceneOptions {
  now: number;
  seerrConfigured: boolean;
}

// --- helpers ---------------------------------------------------------------------

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * Aggregate logical-CPU utilization onto physical cores: each cell is the
 * MEAN of its sibling threads (so a fully busy 2-thread core reads 100%,
 * one busy sibling reads 50% — thread pressure, not double-counted work).
 */
export function physicalCoreCells(
  perCore: number[],
  topology: CpuTopology | null,
): { cells: number[]; cellKind: CpuInstrument["cellKind"] } {
  if (
    topology?.coreSiblings &&
    topology.physicalCores !== null &&
    topology.coreSiblings.length === topology.physicalCores &&
    topology.coreSiblings.every((group) =>
      group.every((id) => id >= 0 && id < perCore.length),
    )
  ) {
    return {
      cellKind: "physical-core",
      cells: topology.coreSiblings.map((group) => {
        const sum = group.reduce((acc, id) => acc + (perCore[id] ?? 0), 0);
        return clamp01(sum / group.length);
      }),
    };
  }
  return { cellKind: "logical-cpu", cells: perCore };
}

export function cpuTopologyLabel(
  topology: CpuTopology | null,
  logicalFallback: number,
): string | null {
  if (topology?.physicalCores !== null && topology?.physicalCores !== undefined) {
    return `${topology.physicalCores}C / ${topology.logicalCpus}T`;
  }
  if (topology) return `${topology.logicalCpus}T`;
  return logicalFallback > 0 ? `${logicalFallback}T` : null;
}

function buildInstrument(snapshot: DashboardSnapshot, scene: SceneModel): InstrumentModel {
  const cpuDomain = snapshot.telemetry.cpu;
  const topology = cpuDomain.value?.topology ?? null;
  const { cells, cellKind } = physicalCoreCells(scene.core.perCore, topology);
  const memory = snapshot.telemetry.memory;
  const gpu = snapshot.telemetry.gpu;
  const arc = snapshot.telemetry.arc;
  const arcFraction =
    arc.value && arc.value.targetBytes && arc.value.targetBytes > 0
      ? clamp01(arc.value.sizeBytes / arc.value.targetBytes)
      : null;
  return {
    cpu: {
      status: cpuDomain.status,
      cells,
      cellKind,
      topologyLabel: cpuTopologyLabel(topology, scene.core.perCore.length),
      totalFraction: scene.core.totalFraction,
      load1: scene.core.load1,
    },
    memory: {
      status: memory.status,
      fraction: scene.core.memFraction,
      primary:
        memory.value?.installedBytes !== null && memory.value?.installedBytes !== undefined
          ? formatBytes(memory.value.installedBytes, { system: "binary", digits: 0 })
          : scene.core.memTotalBytes !== null
            ? formatBytes(scene.core.memTotalBytes, { system: "binary", digits: 0 })
            : null,
      secondary:
        memory.value?.installedBytes !== null &&
        memory.value?.installedBytes !== undefined &&
        scene.core.memTotalBytes !== null
          ? `usable ${formatBytes(scene.core.memTotalBytes, { system: "binary", digits: 0 })}`
          : scene.core.memTotalBytes !== null
            ? "usable memory"
            : null,
    },
    gpu: {
      status: gpu.status,
      fraction: scene.core.gpuFraction,
      name: gpu.value?.name ?? null,
      vramFraction:
        gpu.value && gpu.value.vramTotalBytes > 0
          ? clamp01(gpu.value.vramUsedBytes / gpu.value.vramTotalBytes)
          : null,
      primary:
        scene.core.gpuFraction !== null
          ? `${Math.round(scene.core.gpuFraction * 100)}%`
          : null,
      secondary:
        gpu.value && gpu.value.vramTotalBytes > 0
          ? `${formatBytes(gpu.value.vramUsedBytes)} VRAM`
          : null,
    },
    arc: {
      status: arc.status,
      fraction: arcFraction,
      primary: arc.value ? formatBytes(arc.value.sizeBytes) : null,
      secondary: arc.value?.targetBytes
        ? `of ${formatBytes(arc.value.targetBytes)} target`
        : null,
    },
  };
}

// --- anchors -----------------------------------------------------------------------

function serviceContainer(
  snapshot: DashboardSnapshot,
  names: string[],
): { cpuCores: number | null; memoryBytes: number | null } {
  const containers = snapshot.telemetry.docker.value?.containers ?? [];
  const match = containers.find((c) => {
    const n = c.name.toLowerCase();
    const s = c.composeService?.toLowerCase() ?? "";
    return names.includes(n) || names.includes(s);
  });
  return {
    cpuCores: match?.cpuFraction ?? null,
    memoryBytes: match?.memoryBytes ?? null,
  };
}

function arrow(direction: "down" | "up", bps: number): string {
  return `${direction === "down" ? "↓" : "↑"} ${formatRate(bps)}`;
}

function qbAnchor(snapshot: DashboardSnapshot, scene: SceneModel): AnchorModel {
  const body = scene.services.find((s) => s.id === "qbittorrent");
  const rollup = snapshot.acquisition.rollup;
  // Importing is Arr work and reads under the orchestrators, not here.
  const parts: string[] = [];
  if (rollup.downloading > 0) parts.push(`${rollup.downloading} downloading`);
  if ((rollup.seeding ?? 0) > 0) parts.push(`${rollup.seeding} seeding`);
  const rates: string[] = [];
  if (rollup.aggregateRateBps !== null && rollup.downloading > 0) {
    rates.push(arrow("down", rollup.aggregateRateBps));
  }
  if (
    rollup.uploadRateBps !== null &&
    rollup.uploadRateBps !== undefined &&
    (rollup.seeding ?? 0) > 0
  ) {
    rates.push(arrow("up", rollup.uploadRateBps));
  }
  const active = body?.active ?? false;
  const rateSum =
    (rollup.downloading > 0 ? rollup.aggregateRateBps ?? 0 : 0) +
    ((rollup.seeding ?? 0) > 0 ? rollup.uploadRateBps ?? 0 : 0);
  return {
    id: "qbittorrent",
    label: "qBittorrent",
    status: body?.status ?? "not-configured",
    active,
    headline: parts.length > 0 ? parts.join(" · ") : null,
    rateLine: rates.length > 0 ? rates.join("  ") : null,
    glow: active ? clamp01(0.35 + rateIntensity(rateSum) * 0.65) : 0,
    ...serviceContainer(snapshot, ["qbittorrent"]),
  };
}

function jellyfinAnchor(
  snapshot: DashboardSnapshot,
  scene: SceneModel,
  now: number,
): AnchorModel {
  const body = scene.services.find((s) => s.id === "jellyfin");
  const sessions = snapshot.jellyfin.sessions;
  // ONE canonical rate resolution shared with the playback/egress flows
  // (V4 rate-truth blocker): the anchor's throughput line and glow consume
  // the same headline the kinetic egress ribbon carries, so the wordmark,
  // ribbon, inspector and accessibility text can never disagree. The anchor
  // never re-derives a rate from raw sessions.
  const resolved = resolveJellyfinPlayback(snapshot, now);
  const playing = resolved?.playing ?? sessions.filter((s) => !s.paused);
  const transcoding = resolved?.transcodingCount ?? 0;
  const paused = sessions.length - playing.length;
  const parts: string[] = [];
  if (playing.length > 0) {
    parts.push(playing.length === 1 ? "1 stream" : `${playing.length} streams`);
    if (transcoding > 0) parts.push(`${transcoding} transcoding`);
  }
  if (paused > 0) parts.push(`${paused} paused`);
  const headlineRate = resolved?.egress.headline ?? null;
  const knownBps = headlineRate?.knownBytesPerSecond ?? null;
  let rateLine: string | null = null;
  if (
    headlineRate &&
    knownBps !== null &&
    (knownBps > 0 || isAuthoritativeZero(headlineRate))
  ) {
    // Partial coverage is a lower bound and estimated evidence is an estimate:
    // both carry the ≈ convention. Unknown stays unknown — no line, no zero —
    // and a known zero under partial coverage is equally NOT a rate claim:
    // "≈ 0 B/s" would read as authoritative while the total is unknown.
    const approximate =
      headlineRate.coverage === "partial" || headlineRate.evidence === "estimated";
    rateLine = `${approximate ? "≈ " : ""}${arrow("up", knownBps)}`;
  }
  const active = body?.active ?? false;
  return {
    id: "jellyfin",
    label: "Jellyfin",
    status: body?.status ?? "not-configured",
    active,
    headline: parts.length > 0 ? parts.join(" · ") : null,
    rateLine,
    // Glow energy from the SAME canonical headline: an unknown rate keeps the
    // active baseline (activity exists, magnitude unknown) — never zero-rate
    // darkness while a session is genuinely playing.
    glow: active ? clamp01(0.35 + rateIntensity(knownBps ?? 0) * 0.65) : 0,
    ...serviceContainer(snapshot, [snapshot.jellyfinContainer?.toLowerCase() ?? "jellyfin"]),
  };
}

/** Log-bounded 0..1 intensity for glow energy; 0 below 16 kB/s, 1 at 200 MB/s. */
export function rateIntensity(bps: number): number {
  if (!Number.isFinite(bps) || bps < 16_000) return 0;
  const lo = Math.log10(16_000);
  const hi = Math.log10(200_000_000);
  return clamp01((Math.log10(bps) - lo) / (hi - lo));
}

function orchestration(scene: SceneModel): OrchestratorModel[] {
  const out: OrchestratorModel[] = [];
  for (const id of ["sonarr", "radarr"] as const) {
    const body = scene.services.find((s) => s.id === id);
    if (!body) continue;
    const detail =
      body.status === "down"
        ? "unavailable"
        : body.status === "degraded"
          ? "degraded"
          : body.active && body.count !== null
            ? `${body.count} active`
            : "idle";
    out.push({
      id,
      label: body.label,
      status: body.status,
      active: body.active,
      detail,
    });
  }
  return out;
}

// --- workload field ------------------------------------------------------------------

const FIELD_LABEL_INTENSITY = 0.45;

function fieldCell(c: DockerContainerModel, id: string): FieldCellModel {
  const intensity =
    c.cpuFraction === null ? null : clamp01(1 - Math.exp(-Math.max(0, c.cpuFraction) / 0.5));
  const running = c.state === "running";
  return {
    id,
    name: c.name,
    sizeScore: c.memoryScore,
    intensity,
    ioHalo: c.ioIntensity,
    attention: c.bad,
    unverified: c.unverified,
    running,
    labelVisible:
      c.bad || (intensity !== null && intensity >= FIELD_LABEL_INTENSITY) || c.ioIntensity >= 0.5,
    cpuFraction: c.cpuFraction,
    memoryBytes: c.memoryBytes,
  };
}

function buildField(snapshot: DashboardSnapshot, scene: SceneModel): FieldGroupModel[] {
  const containers = snapshot.telemetry.docker.value?.containers ?? [];
  const groups = groupWorkloads(containers);
  const byName = new Map(scene.docker.containers.map((c) => [c.name, c]));
  return groups
    .map((group) => {
      const cells = group.members
        .map((member) => {
          const model = byName.get(member.name);
          return model ? fieldCell(model, member.id) : null;
        })
        .filter((cell): cell is FieldCellModel => cell !== null);
      // Declutter: attention always names itself; beyond that only the two
      // most active cells per group carry a label.
      const labeled = cells
        .filter((c) => c.labelVisible && !c.attention)
        .sort((a, b) => (b.intensity ?? 0) - (a.intensity ?? 0) || a.id.localeCompare(b.id))
        .slice(0, 2);
      const keep = new Set(labeled.map((c) => c.id));
      for (const cell of cells) {
        if (!cell.attention && cell.labelVisible && !keep.has(cell.id)) {
          cell.labelVisible = false;
        }
      }
      return {
        id: group.id,
        label: group.label,
        attentionCount: group.attentionCount,
        cells,
      };
    })
    .filter((group) => group.cells.length > 0);
}

// --- storage ---------------------------------------------------------------------------

function stratum(
  pool: StorageBodyModel,
  role: StorageStratumModel["role"],
): StorageStratumModel {
  return {
    name: pool.name,
    role,
    capacityFraction: pool.capacityFraction,
    capacityTone: pool.capacityTone,
    usedLabel: formatBytes(pool.capacityLabelBytes.used),
    totalLabel: formatBytes(pool.capacityLabelBytes.total),
    totalBytes: pool.capacityLabelBytes.total,
    healthy: pool.healthy,
    healthLabel: pool.healthLabel,
    scrubbing: pool.scrubbing,
    readBps: pool.readBps,
    writeBps: pool.writeBps,
    ioFreshness: pool.ioFreshness,
    capacityBasis: pool.capacityBasis,
  };
}

function buildStorage(scene: SceneModel): StorageStratumModel[] {
  const roleOf = (name: string): StorageStratumModel["role"] =>
    name === scene.downloadPoolName
      ? "download"
      : name === scene.mediaPoolName
        ? "media"
        : "other";
  // Left → right: download staging, media library, everything else by rank.
  const rolesRank: Record<StorageStratumModel["role"], number> = {
    download: 0,
    media: 1,
    other: 2,
  };
  return [...scene.storage]
    .sort((a, b) => {
      const ra = rolesRank[roleOf(a.name)];
      const rb = rolesRank[roleOf(b.name)];
      return ra !== rb ? ra - rb : a.rank - b.rank;
    })
    .map((pool) => stratum(pool, roleOf(pool.name)));
}

// --- flows -----------------------------------------------------------------------------

function poolRef(
  endpoint: FlowObservation["from"] | FlowObservation["to"],
  side: "network" | "service-side",
): KineticNodeRef | null {
  switch (endpoint.kind) {
    case "network":
      return { kind: "edge", id: side === "network" ? "wan" : "clients" };
    case "service":
      if (endpoint.id === "sonarr" || endpoint.id === "radarr") {
        return { kind: "orchestrator", id: endpoint.id };
      }
      if (endpoint.id === "qbittorrent" || endpoint.id === "jellyfin") {
        return { kind: "anchor", id: endpoint.id };
      }
      return null;
    case "pool":
      return { kind: "pool", name: endpoint.name };
    case "storage":
      return { kind: "storage" };
  }
}

/**
 * Map the shared flow-rate truth classification (activity layer) onto the
 * kinetic visual treatment. The renderer never re-derives rate semantics from
 * the numeric rate alone: a numeric zero is a confirmed zero ONLY when the
 * authoritative aggregate proves it (complete coverage, no unknown
 * contributors, live, evidence-backed). A partial known-zero is a lower
 * bound — activity exists, the total rate is unknown — and renders as
 * state-only: no particles, no throughput-scaled width, no zero claim.
 */
function treatmentOf(flow: FlowObservation): FlowTreatment {
  switch (classifyFlowRate(flow)) {
    case "stale":
      return "stale";
    case "positive":
      return "particles";
    case "confirmed-zero":
      return "confirmed-zero";
    case "unknown":
      return "state-only";
  }
}

function toneOf(flow: FlowObservation): KineticFlow["tone"] {
  if (flow.plane === "control") return "control";
  if (flow.kind === "import-copy" || flow.kind === "background-transfer") return "import";
  if (flow.kind === "playback" || flow.kind === "egress") return "out";
  if (flow.kind === "wan-transfer" || flow.kind === "storage-transfer") return "in";
  return "in";
}

function buildFlows(scene: SceneModel): KineticFlow[] {
  const out: KineticFlow[] = [];
  for (const flow of scene.flows) {
    const wanSide = flow.kind === "wan-transfer" ? "network" : "service-side";
    const from = poolRef(flow.from, wanSide);
    const to = poolRef(flow.to, flow.kind === "egress" ? "service-side" : wanSide);
    if (!from || !to) continue;
    const rate = primaryRate(flow);
    const treatment = flow.plane === "control" ? "state-only" : treatmentOf(flow);
    out.push({
      id: flow.id,
      kind: flow.kind,
      from,
      to,
      treatment,
      tone: toneOf(flow),
      // State-only carries NO headline rate: in particular a partial
      // known-zero (rate 0, coverage incomplete) must never surface "0 B/s"
      // in the inspector or accessibility text as if it were authoritative.
      rateBps: treatment === "state-only" ? null : rate,
      channels: flow.channels.map((c) => ({
        direction: c.direction,
        bytesPerSecond: c.bytesPerSecond,
      })),
      boundary: flowNetworkBoundary(flow),
      label: flow.label,
      provenance: flow.provenance,
    });
  }
  return out;
}

// --- attention ---------------------------------------------------------------------------

function buildAttention(snapshot: DashboardSnapshot): AttentionSummaryModel {
  const critical = snapshot.attention.filter((a) => a.severity === "critical").length;
  const warning = snapshot.attention.filter((a) => a.severity === "warning").length;
  let headline: string | null = null;
  if (critical > 0 && warning > 0) {
    headline = `${critical} critical · ${warning} warning`;
  } else if (critical > 0) {
    headline = `${critical} critical`;
  } else if (warning > 0) {
    headline = `${warning} warning${warning > 1 ? "s" : ""}`;
  }
  return { critical, warning, headline };
}

// --- entry ---------------------------------------------------------------------------------

export function buildKineticScene(
  snapshot: DashboardSnapshot,
  options: KineticSceneOptions,
): KineticScene {
  const scene = buildSceneModel(snapshot, {
    now: options.now,
    seerrConfigured: options.seerrConfigured,
  });
  const flows = buildFlows(scene);
  const wanActive = flows.some(
    (f) =>
      f.treatment === "particles" &&
      ((f.from.kind === "edge" && f.from.id === "wan") ||
        (f.to.kind === "edge" && f.to.id === "wan")),
  );
  const clientsActive = flows.some(
    (f) => f.treatment === "particles" && f.to.kind === "edge" && f.to.id === "clients",
  );
  // Typed network-boundary truth (V3 → V4 graduation): the client edge names
  // ONLY boundaries that a client-terminating flow is actually known to
  // cross. Without typed evidence the label is the neutral CLIENTS — traffic
  // existing never implies WAN, and LAN/WAN/TAILSCALE never light together
  // on speculation. Exact Docker-network identity stays in the model,
  // invisible in overview.
  const BOUNDARY_LABELS: Partial<Record<FlowNetworkBoundary, string>> = {
    lan: "LAN",
    wan: "WAN",
    overlay: "TAILSCALE",
  };
  const clientLabels = [
    ...new Set(
      flows
        .filter((f) => f.to.kind === "edge" && f.to.id === "clients")
        .map((f) => BOUNDARY_LABELS[f.boundary])
        .filter((label): label is string => label !== undefined),
    ),
  ];
  return {
    demo: snapshot.mode === "fake",
    hostLabel: scene.core.hostname,
    instrument: buildInstrument(snapshot, scene),
    anchors: [
      qbAnchor(snapshot, scene),
      jellyfinAnchor(snapshot, scene, options.now),
    ],
    orchestration: orchestration(scene),
    edges: [
      { id: "wan", labels: ["WAN"], side: "left", active: wanActive },
      {
        id: "clients",
        labels: clientLabels.length > 0 ? clientLabels : ["CLIENTS"],
        side: "right",
        active: clientsActive,
      },
    ],
    field: buildField(snapshot, scene),
    // A running/total claim is only made while Docker telemetry is usable;
    // retained last-known identity keeps the field visible but must not
    // assert a live workload count.
    fieldTotal:
      snapshot.telemetry.docker.status === "available" ||
      snapshot.telemetry.docker.status === "stale"
        ? scene.docker.total
        : null,
    fieldRunning:
      snapshot.telemetry.docker.status === "available" ||
      snapshot.telemetry.docker.status === "stale"
        ? scene.docker.running
        : null,
    storage: buildStorage(scene),
    flows,
    attention: buildAttention(snapshot),
    critical: scene.critical,
  };
}

/**
 * Real activity → evidence-aware flow observations (PLA-267/275) — pure, tested.
 *
 * Derives which semantic relationships are alive from the normalized snapshot,
 * carrying enough truth for the renderer to draw honestly:
 *
 *  - PLANE: data-plane observations represent actual (or credibly derived)
 *    byte movement and may render as throughput-sized tunnels; control-plane
 *    observations represent orchestration/state and may only render as thin
 *    signal paths — never as data tunnels;
 *  - EVIDENCE: `measured` (a counter for this exact path), `derived` (a real
 *    measurement attributed across a path, e.g. session bitrate standing in
 *    for a disk read), `state-only` (work exists, rate unknown — width must
 *    never imply throughput);
 *  - FRESHNESS: `live` or `stale`. A stale justifying source freezes its flow
 *    (no particle motion, no endpoint excitation); an unavailable or
 *    unconfigured source suppresses the flow entirely — absence of evidence
 *    renders as quiet topology, never as confirmed zero;
 *  - CHANNELS: directional sub-flows sharing one conduit (download + seed on
 *    the WAN link), each with its own nullable bytes/sec.
 *
 * Hard rules preserved from the previous model:
 *  - motion only from REAL state: no downloads → no acquisition flows, no
 *    sessions → no playback flows, ever;
 *  - Sonarr/Radarr are CONTROLLERS: the downloaded bytes never pass through
 *    them. Their queue ownership justifies a control signal to the
 *    downloader, and their importing state justifies import activity;
 *  - a same-pool import (rename/hardlink) is LOCAL organizing on the storage
 *    body — never a bulk cross-scene transfer. Only a cross-pool import with
 *    corroborating destination writes becomes a data tunnel, and its carrier
 *    is storage→storage with the Arr as control-plane initiator;
 *  - storage identity is never inferred from dominant pool I/O. Media flows
 *    attach to the operator-declared pools (`snapshot.mediaPool`,
 *    `snapshot.downloadPool`) or to a deliberately generic storage endpoint.
 *    Less specific beats confidently wrong;
 *  - every observation is gated on the freshness of the EXACT source that
 *    justifies it.
 */

import { FLOW_DEADBAND_BPS } from "@/lib/topology/smoothing";
import { isConnectorStale } from "@/lib/types";
import type {
  AggregateRateObservation,
  DashboardSnapshot,
  JellyfinSession,
  RateBasis,
  RateEvidence,
} from "@/lib/types";

export type ServiceEndpointId = "jellyfin" | "sonarr" | "radarr" | "qbittorrent";
export type FlowControllerServiceId = Extract<ServiceEndpointId, "sonarr" | "radarr">;

/** A semantic flow endpoint. The renderer maps these onto scene bodies. */
export type FlowEndpoint =
  | { kind: "network" }
  | { kind: "service"; id: ServiceEndpointId }
  | { kind: "pool"; name: string }
  /** Generic storage: media landed/served on disk but no pool was declared. */
  | { kind: "storage" };

export type FlowPlane = "data" | "control";

export type FlowEvidence = "measured" | "derived" | "state-only";

export type FlowFreshness = "live" | "stale";

export type FlowKind =
  | "wan-transfer" // network ↔ downloader (download + seed upload channels)
  | "storage-transfer" // downloader ↔ download storage (write + seed-read)
  | "import-copy" // cross-pool import: source storage → destination storage
  | "background-transfer" // corroborated pool-to-pool copy with no named controller
  | "playback" // media storage → Jellyfin
  | "egress" // Jellyfin → network
  | "control" // Arr ↔ downloader orchestration
  | "organize"; // Arr → storage import/organizing signal (local work)

export type ChannelRole = "ingress" | "egress" | "read" | "write";

export interface FlowChannel {
  /** forward = from → to, reverse = to → from. */
  direction: "forward" | "reverse";
  role: ChannelRole;
  /** Bytes per second when known; null = active but rate unknown. */
  bytesPerSecond: number | null;
}

export interface FlowObservation {
  /** Stable id derived from kind + endpoints (safe as a render key). */
  id: string;
  kind: FlowKind;
  plane: FlowPlane;
  from: FlowEndpoint;
  to: FlowEndpoint;
  evidence: FlowEvidence;
  freshness: FlowFreshness;
  channels: FlowChannel[];
  /** Human-readable observation source, for hover/detail provenance. */
  provenance: string;
  /** Short semantic description ("qBittorrent download"). */
  label: string;
  /** Epoch ms of the justifying source's last success, when known. */
  updatedAt: number | null;
  /** Typed aggregate rate for flows whose coverage/source needs explanation. */
  rate?: AggregateRateObservation;
  /** Controller attribution when the observation is owned by one Arr service. */
  controllerServiceId?: FlowControllerServiceId;
  /**
   * Rate observations that were CONSIDERED but did not become the headline —
   * kept for detail/accessibility surfaces instead of being erased. The
   * canonical case: a live measured container window of 0 B/s during
   * buffered playback, retained as supporting evidence while the nonzero
   * session aggregate carries the headline.
   */
  supportingRates?: AggregateRateObservation[];
}

function endpointKey(e: FlowEndpoint): string {
  switch (e.kind) {
    case "network":
      return "network";
    case "service":
      return e.id;
    case "pool":
      return `pool:${e.name}`;
    case "storage":
      return "storage";
  }
}

function makeFlow(
  kind: FlowKind,
  from: FlowEndpoint,
  to: FlowEndpoint,
  rest: Omit<FlowObservation, "id" | "kind" | "from" | "to">,
): FlowObservation {
  return {
    id: `${kind}:${endpointKey(from)}->${endpointKey(to)}`,
    kind,
    from,
    to,
    ...rest,
  };
}

function controllerForItems(
  items: DashboardSnapshot["acquisition"]["items"],
  states: readonly DashboardSnapshot["acquisition"]["items"][number]["state"][],
): FlowControllerServiceId | undefined {
  const controllers = new Set<FlowControllerServiceId>();
  for (const item of items) {
    if (!states.includes(item.state)) continue;
    if (item.source === "sonarr" || item.source === "radarr") controllers.add(item.source);
  }
  if (controllers.size !== 1) return undefined;
  return [...controllers][0];
}

type SourceState =
  | { usable: false }
  | { usable: true; freshness: FlowFreshness; updatedAt: number | null };

/**
 * Whether a connector can justify a flow at all, and how fresh it is.
 * Unavailable / unconfigured → unusable (suppress); stale → usable but frozen.
 */
function sourceState(
  snapshot: DashboardSnapshot,
  id: ServiceEndpointId,
  now: number,
): SourceState {
  const health = snapshot.health.find((h) => h.id === id);
  if (!health || !health.configured || health.status === "unavailable") {
    return { usable: false };
  }
  return {
    usable: true,
    freshness: isConnectorStale(health, now) ? "stale" : "live",
    updatedAt: health.lastSuccessAt,
  };
}

/** Resolve a declared pool name against the pools that actually exist. */
function declaredPool(
  snapshot: DashboardSnapshot,
  declared: string | null | undefined,
): FlowEndpoint | null {
  if (declared && snapshot.zfs.pools.some((p) => p.name === declared)) {
    return { kind: "pool", name: declared };
  }
  return null;
}

/**
 * Where media (import destination / playback source) flows meet storage.
 * ONLY the operator-declared pool may be named; otherwise generic storage.
 */
export function mediaStorageEndpoint(snapshot: DashboardSnapshot): FlowEndpoint {
  return declaredPool(snapshot, snapshot.mediaPool) ?? { kind: "storage" };
}

/** Where downloader storage flows meet storage. Same declaration-only rule. */
export function downloadStorageEndpoint(snapshot: DashboardSnapshot): FlowEndpoint {
  return declaredPool(snapshot, snapshot.downloadPool) ?? { kind: "storage" };
}

/**
 * Write throughput for a DECLARED pool, used only to corroborate/scale an
 * already-justified flow — never to invent or retarget one. Null when the
 * endpoint is generic or disk telemetry is missing/stale.
 */
function poolWriteBps(
  snapshot: DashboardSnapshot,
  target: FlowEndpoint,
): number | null {
  if (target.kind !== "pool") return null;
  const disk = snapshot.telemetry.disk;
  if (disk.status !== "available" || !disk.value) return null;
  return disk.value.pools.find((p) => p.pool === target.name)?.writeBps ?? null;
}

/**
 * Read throughput for a DECLARED pool, used only to corroborate a storage
 * source that should be feeding a derived transfer. Null when the endpoint is
 * generic or disk telemetry is missing/stale.
 */
function poolReadBps(
  snapshot: DashboardSnapshot,
  target: FlowEndpoint,
): number | null {
  if (target.kind !== "pool") return null;
  const disk = snapshot.telemetry.disk;
  if (disk.status !== "available" || !disk.value) return null;
  return disk.value.pools.find((p) => p.pool === target.name)?.readBps ?? null;
}

function earliestUpdatedAt(...times: Array<number | null | undefined>): number | null {
  let min: number | null = null;
  for (const time of times) {
    if (typeof time !== "number" || !Number.isFinite(time)) continue;
    min = min === null ? time : Math.min(min, time);
  }
  return min;
}

const rate = (bps: number | null | undefined): number | null =>
  typeof bps === "number" && Number.isFinite(bps) ? Math.max(0, bps) : null;

interface NamedPoolFlowCandidate {
  pool: string;
  bytesPerSecond: number;
}

// A pool direction is attributable only when the leading real ZFS pool owns
// at least four-fifths of all eligible bytes and runs at least 4× the next
// pool. The share protects against a crowd of smaller contributors; the ratio
// prevents one genuinely competitive runner-up from being hidden in the sum.
// The deadband remains only the minimum material rate for the leader.
const POOL_DIRECTION_DOMINANCE_SHARE = 0.8;
const POOL_DIRECTION_RUNNER_UP_RATIO = 4;

function dominantNamedPoolCandidate(
  snapshot: DashboardSnapshot,
  field: "readBps" | "writeBps",
  excludedPools: ReadonlySet<string>,
): NamedPoolFlowCandidate | null {
  const disk = snapshot.telemetry.disk;
  if ((disk.status !== "available" && disk.status !== "stale") || !disk.value) {
    return null;
  }
  const realPools = new Set(snapshot.zfs.pools.map((pool) => pool.name));
  const eligible = disk.value.pools
    .filter(
      (pool) =>
        pool.pool !== "other" &&
        realPools.has(pool.pool) &&
        !excludedPools.has(pool.pool),
    )
    .map((pool) => ({ pool: pool.pool, bytesPerSecond: rate(pool[field]) ?? 0 }))
    .sort((a, b) => b.bytesPerSecond - a.bytesPerSecond);
  const top = eligible[0];
  if (!top || top.bytesPerSecond < FLOW_DEADBAND_BPS) return null;

  const total = eligible.reduce(
    (sum, candidate) => sum + candidate.bytesPerSecond,
    0,
  );
  const runnerUp = eligible[1]?.bytesPerSecond ?? 0;
  const hasStrongShare =
    top.bytesPerSecond / total >= POOL_DIRECTION_DOMINANCE_SHARE;
  const clearsRunnerUp =
    runnerUp === 0 ||
    top.bytesPerSecond / runnerUp >= POOL_DIRECTION_RUNNER_UP_RATIO;
  if (!hasStrongShare || !clearsRunnerUp) return null;

  return {
    pool: top.pool,
    bytesPerSecond: top.bytesPerSecond,
  };
}

/**
 * Aggregate for a transfer conduit whose per-direction rates come from one
 * measured source (qBittorrent counters, or those counters attributed to the
 * storage hop). `contributors` holds one entry per ACTIVE direction — null
 * when that direction's rate is unknown — so a known-zero direction next to
 * an unknown active direction is honestly partial, never a confirmed zero.
 */
function transferRateAggregate(
  contributors: ReadonlyArray<number | null>,
  evidence: RateEvidence,
  freshness: FlowFreshness,
): AggregateRateObservation {
  const known = contributors.filter((value): value is number => value !== null);
  return {
    knownBytesPerSecond:
      known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : null,
    unknownContributors: contributors.length - known.length,
    coverage:
      known.length === 0
        ? "unknown"
        : known.length < contributors.length
          ? "partial"
          : "complete",
    basis: null,
    evidence: known.length > 0 ? evidence : null,
    freshness,
  };
}

function weakestEvidence(values: RateEvidence[]): RateEvidence {
  if (values.includes("estimated")) return "estimated";
  if (values.includes("derived")) return "derived";
  if (values.includes("reported")) return "reported";
  return "measured";
}

/**
 * Aggregate the ACTIVELY PLAYING sessions only. Paused sessions are excluded
 * from both the known-rate sum and the unknown-contributor count: a paused
 * player is moving no bytes, so counting it either way would overstate demand
 * (as a rate) or fabricate uncertainty (as an unknown). Callers pass playing
 * sessions; this function additionally guards so a paused session can never
 * leak into an aggregate.
 */
function sessionRateAggregate(
  sessions: JellyfinSession[],
  freshness: FlowFreshness,
): AggregateRateObservation {
  const playing = sessions.filter((session) => !session.paused);
  const known = playing.flatMap((session) => (session.rate ? [session.rate] : []));
  const unknownContributors = playing.length - known.length;
  const knownBytesPerSecond =
    known.length > 0
      ? known.reduce((sum, observation) => sum + observation.bytesPerSecond, 0)
      : null;
  const bases = new Set(known.map((observation) => observation.basis));
  const basis: RateBasis | null =
    bases.size === 0
      ? null
      : bases.size === 1
        ? known[0]!.basis
        : "mixed-session-sources";
  return {
    knownBytesPerSecond,
    unknownContributors,
    coverage:
      known.length === 0
        ? "unknown"
        : unknownContributors > 0
          ? "partial"
          : "complete",
    basis,
    evidence: known.length > 0 ? weakestEvidence(known.map((o) => o.evidence)) : null,
    freshness,
  };
}

function mappedJellyfinContainer(snapshot: DashboardSnapshot) {
  const configuredName = snapshot.jellyfinContainer;
  if (!configuredName) return null;
  const docker = snapshot.telemetry.docker;
  const container = docker.value?.containers.find((item) => item.name === configuredName);
  return container ? { container, status: docker.status, updatedAt: docker.updatedAt } : null;
}

function containerRate(
  snapshot: DashboardSnapshot,
  field: "netTxBps" | "blockReadBps",
): AggregateRateObservation | null {
  const mapped = mappedJellyfinContainer(snapshot);
  if (!mapped) return null;
  const value = rate(mapped.container[field]);
  if (value === null || (mapped.status !== "available" && mapped.status !== "stale")) {
    return null;
  }
  return {
    knownBytesPerSecond: value,
    unknownContributors: 0,
    coverage: "complete",
    basis: field === "netTxBps" ? "container-egress" : "container-block-read",
    evidence: "measured",
    freshness: mapped.status === "available" ? "live" : "stale",
  };
}

function storageAttribution(
  aggregate: AggregateRateObservation,
): AggregateRateObservation {
  if (aggregate.knownBytesPerSecond === null) return aggregate;
  return {
    ...aggregate,
    basis: "storage-attribution",
    evidence: aggregate.evidence === "estimated" ? "estimated" : "derived",
  };
}

/**
 * Documented headline-rate precedence for the Jellyfin playback legs
 * (V2.1 rate-truth blocker):
 *
 *  1. a POSITIVE live measured container rate wins;
 *  2. otherwise a POSITIVE session aggregate wins — a zero container sampling
 *     window (buffered playback pauses I/O between bursts) must never erase a
 *     useful nonzero session observation, but the measured zero is RETAINED
 *     as supporting detail rather than discarded;
 *  3. a measured zero becomes the headline only when no contradictory active
 *     rate evidence exists;
 *  4. otherwise whichever observation still carries information (session
 *     aggregate, then stale container data).
 */
export function pickHeadlineRate(
  container: AggregateRateObservation | null,
  session: AggregateRateObservation,
): { headline: AggregateRateObservation; supporting: AggregateRateObservation[] } {
  const containerLive = container !== null && container.freshness === "live";
  const containerKnown = containerLive && container.knownBytesPerSecond !== null;
  const containerPositive = containerKnown && container.knownBytesPerSecond! > 0;
  const sessionPositive =
    session.knownBytesPerSecond !== null && session.knownBytesPerSecond > 0;

  if (containerPositive) return { headline: container, supporting: [] };
  if (sessionPositive) {
    return { headline: session, supporting: containerKnown ? [container] : [] };
  }
  if (containerKnown) return { headline: container, supporting: [] };
  if (session.knownBytesPerSecond !== null) return { headline: session, supporting: [] };
  return { headline: container ?? session, supporting: [] };
}

/**
 * THE canonical resolved Jellyfin playback-rate observation (V4 rate-truth
 * blocker): every consumer — the playback and egress flows, the Jellyfin
 * wordmark anchor and its glow energy, ribbons, inspectors, and accessibility
 * text — derives from this single resolution. No renderer may re-derive a
 * Jellyfin rate from raw sessions; that is how the V2.1 measured-fallback
 * regression happened.
 */
export interface ResolvedJellyfinPlayback {
  /** Actively playing sessions (paused sessions justify nothing). */
  playing: JellyfinSession[];
  pausedCount: number;
  transcodingCount: number;
  /** Jellyfin → network leg: headline + retained supporting evidence. */
  egress: {
    headline: AggregateRateObservation;
    supporting: AggregateRateObservation[];
  };
  /** storage → Jellyfin leg (storage-attributed): headline + supporting. */
  playback: {
    headline: AggregateRateObservation;
    supporting: AggregateRateObservation[];
  };
  egressFreshness: FlowFreshness;
  playbackFreshness: FlowFreshness;
  /** Connector-level freshness/updatedAt of the Jellyfin source itself. */
  connectorFreshness: FlowFreshness;
  connectorUpdatedAt: number | null;
}

/**
 * Resolve the canonical Jellyfin playback rates. Returns null when the
 * Jellyfin connector cannot justify observations (unavailable/unconfigured)
 * or when nothing is actively playing — absence of evidence, never zero.
 */
export function resolveJellyfinPlayback(
  snapshot: DashboardSnapshot,
  now: number,
): ResolvedJellyfinPlayback | null {
  const jellyfin = sourceState(snapshot, "jellyfin", now);
  if (!jellyfin.usable) return null;
  const sessions = snapshot.jellyfin.sessions;
  const playing = sessions.filter((s) => !s.paused);
  if (playing.length === 0) return null;
  const sessionAggregate = sessionRateAggregate(playing, jellyfin.freshness);
  const containerEgress = containerRate(snapshot, "netTxBps");
  const containerReads = containerRate(snapshot, "blockReadBps");
  const egress = pickHeadlineRate(containerEgress, sessionAggregate);
  const playback = pickHeadlineRate(
    containerReads,
    storageAttribution(sessionAggregate),
  );
  const egressFreshness: FlowFreshness =
    jellyfin.freshness === "stale" || egress.headline.freshness === "stale"
      ? "stale"
      : "live";
  const playbackFreshness: FlowFreshness =
    jellyfin.freshness === "stale" || playback.headline.freshness === "stale"
      ? "stale"
      : "live";
  return {
    playing,
    pausedCount: sessions.length - playing.length,
    transcodingCount: playing.filter((s) => s.method === "transcode").length,
    egress: {
      headline: { ...egress.headline, freshness: egressFreshness },
      supporting: egress.supporting,
    },
    playback: {
      headline: { ...playback.headline, freshness: playbackFreshness },
      supporting: playback.supporting,
    },
    egressFreshness,
    playbackFreshness,
    connectorFreshness: jellyfin.freshness,
    connectorUpdatedAt: jellyfin.updatedAt,
  };
}

/**
 * The network boundary a flow's external endpoint is KNOWN to cross.
 * qBittorrent's WAN transfer is a WAN claim by protocol semantics; a playback
 * egress without typed boundary evidence is `unknown` — the renderer must use
 * a neutral client treatment, never imply LAN/WAN/overlay simultaneously.
 * Declared overrides (typed upstream evidence) always win.
 */
export type FlowNetworkBoundary =
  | "wan"
  | "lan"
  | "overlay"
  | "docker-internal"
  | "host-local"
  | "unknown";

export function flowNetworkBoundary(
  flow: FlowObservation,
  overrides?: Readonly<Record<string, FlowNetworkBoundary>>,
): FlowNetworkBoundary {
  const declared = overrides?.[flow.id];
  if (declared) return declared;
  if (flow.kind === "wan-transfer") return "wan";
  if (flow.from.kind === "network" || flow.to.kind === "network") return "unknown";
  if (flow.plane === "control" && flow.from.kind === "service" && flow.to.kind === "service") {
    return "docker-internal";
  }
  return "host-local";
}

/** Derive every observable flow from the snapshot. Idle input → empty array. */
export function deriveFlows(
  snapshot: DashboardSnapshot,
  now: number,
): FlowObservation[] {
  const flows: FlowObservation[] = [];
  const acq = snapshot.acquisition;
  const qb = sourceState(snapshot, "qbittorrent", now);
  const sonarr = sourceState(snapshot, "sonarr", now);
  const radarr = sourceState(snapshot, "radarr", now);
  const mediaStorage = mediaStorageEndpoint(snapshot);
  const downloadStorage = downloadStorageEndpoint(snapshot);

  // --- WAN ↔ downloader + downloader ↔ storage (data plane) -----------------
  if (qb.usable) {
    const downloadBps = rate(acq.rollup.aggregateRateBps);
    const uploadBps = rate(acq.rollup.uploadRateBps ?? null);
    const downloadingActive = acq.rollup.downloading > 0;
    const seedingActive = (acq.rollup.seeding ?? 0) > 0;
    const controllerServiceId = controllerForItems(
      acq.items,
      ["downloading", "searching", "importing"],
    );

    if (downloadingActive || seedingActive) {
      // Activity state establishes that the semantic relationship exists;
      // the nullable counters establish only its magnitude. Keeping one
      // contributor and channel per ACTIVE direction lets the shared rate
      // classifier distinguish positive, complete zero, partial, and unknown
      // truth without turning null into zero or hiding known work. Rendering
      // still applies its existing deadband to small positive rates.
      const contributors: Array<number | null> = [
        ...(downloadingActive ? [downloadBps] : []),
        ...(seedingActive ? [uploadBps] : []),
      ];
      // One shared WAN conduit; download and seed-upload are opposite
      // channels on it, each carrying its own measured rate — or null when
      // the direction is active but its rate is unknown.
      const anyKnown = contributors.some((value) => value !== null);
      const channels: FlowChannel[] = [];
      if (downloadingActive) {
        channels.push({
          direction: "forward",
          role: "ingress",
          bytesPerSecond: downloadBps,
        });
      }
      if (seedingActive) {
        channels.push({
          direction: "reverse",
          role: "egress",
          bytesPerSecond: uploadBps,
        });
      }
      flows.push(
        makeFlow("wan-transfer", { kind: "network" }, { kind: "service", id: "qbittorrent" }, {
          plane: "data",
          evidence: anyKnown ? "measured" : "state-only",
          freshness: qb.freshness,
          channels,
          rate: transferRateAggregate(contributors, "measured", qb.freshness),
          provenance: anyKnown
            ? "measured by qBittorrent transfer counters"
            : "activity reported by qBittorrent; transfer rate unavailable",
          label:
            downloadingActive && seedingActive
              ? "qBittorrent download + seed"
              : downloadingActive
                ? "qBittorrent download"
                : "qBittorrent seeding",
          updatedAt: qb.updatedAt,
          controllerServiceId,
        }),
      );

      // The same bytes meet storage on the downloader's other side. The rates
      // are qBittorrent's transfer counters ATTRIBUTED to the storage hop, so
      // this is derived, not measured — ARC/page cache may absorb part of it.
      const storageChannels: FlowChannel[] = [];
      if (downloadingActive) {
        storageChannels.push({
          direction: "forward",
          role: "write",
          bytesPerSecond: downloadBps,
        });
      }
      if (seedingActive) {
        storageChannels.push({
          direction: "reverse",
          role: "read",
          bytesPerSecond: uploadBps,
        });
      }
      flows.push(
        makeFlow("storage-transfer", { kind: "service", id: "qbittorrent" }, downloadStorage, {
          plane: "data",
          evidence: anyKnown ? "derived" : "state-only",
          freshness: qb.freshness,
          channels: storageChannels,
          rate: transferRateAggregate(contributors, "derived", qb.freshness),
          provenance:
            anyKnown && downloadStorage.kind === "pool"
              ? "derived from qBittorrent rates; destination declared by HOMELAB_DOWNLOAD_POOL"
              : anyKnown
                ? "derived from qBittorrent rates; storage destination not declared"
                : downloadStorage.kind === "pool"
                  ? "activity reported by qBittorrent; destination declared by HOMELAB_DOWNLOAD_POOL; transfer rate unavailable"
                  : "activity reported by qBittorrent; storage destination and transfer rate unavailable",
          label: downloadingActive
            ? "download landing on storage"
            : "seeding from storage",
          updatedAt: qb.updatedAt,
          controllerServiceId,
        }),
      );
    }
  }

  // --- Arr ↔ downloader control signals (control plane) ---------------------
  // Owning active queue items = live orchestration. This lane never carries
  // bytes and never sizes with throughput.
  for (const arr of ["sonarr", "radarr"] as const) {
    const src = arr === "sonarr" ? sonarr : radarr;
    if (!src.usable || !qb.usable) continue;
    const owned = acq.items.some(
      (i) =>
        i.source === arr &&
        (i.state === "downloading" || i.state === "importing" || i.state === "searching"),
    );
    if (!owned) continue;
    const freshness: FlowFreshness =
      src.freshness === "stale" || qb.freshness === "stale" ? "stale" : "live";
    flows.push(
      makeFlow("control", { kind: "service", id: arr }, { kind: "service", id: "qbittorrent" }, {
        plane: "control",
        evidence: "state-only",
        freshness,
        channels: [{ direction: "forward", role: "egress", bytesPerSecond: null }],
        provenance: `queue ownership reported by ${arr === "sonarr" ? "Sonarr" : "Radarr"}`,
        label: `${arr === "sonarr" ? "Sonarr" : "Radarr"} orchestrating qBittorrent`,
        updatedAt: src.updatedAt,
        controllerServiceId: arr,
      }),
    );
  }

  // --- imports (the Arr ACTUALLY importing) ----------------------------------
  // Same-pool (or unattributable) import: LOCAL organizing — a control signal
  // from the Arr to the destination storage plus surface activity there,
  // never a bulk tunnel. Cross-pool with corroborating destination writes:
  // a real storage→storage copy tunnel, with the Arr staying control-plane.
  const crossPool =
    mediaStorage.kind === "pool" &&
    downloadStorage.kind === "pool" &&
    mediaStorage.name !== downloadStorage.name;

  let importCopyEmitted = false;
  const explicitImportPools = new Set<string>();
  for (const arr of ["sonarr", "radarr"] as const) {
    const src = arr === "sonarr" ? sonarr : radarr;
    if (!src.usable) continue;
    const importing = acq.items.some(
      (i) => i.source === arr && i.state === "importing",
    );
    if (!importing) continue;
    const arrName = arr === "sonarr" ? "Sonarr" : "Radarr";

    // The organizing signal is always present while importing: the Arr is
    // doing real work whose byte rate is not measured on this lane.
    flows.push(
      makeFlow("organize", { kind: "service", id: arr }, mediaStorage, {
        plane: "control",
        evidence: "state-only",
        freshness: src.freshness,
        channels: [{ direction: "forward", role: "write", bytesPerSecond: null }],
        provenance: `import state reported by ${arrName}; byte rate not measured on this lane`,
        label: `${arrName} importing`,
        updatedAt: src.updatedAt,
        controllerServiceId: arr,
      }),
    );

    // Cross-pool copy tunnel (once, shared by both Arrs): only when both pool
    // identities are declared AND disk telemetry corroborates bytes leaving
    // the source pool and arriving at the destination pool.
    if (crossPool && !importCopyEmitted && src.freshness === "live") {
      const sourceRead = poolReadBps(snapshot, downloadStorage);
      const destWrite = poolWriteBps(snapshot, mediaStorage);
      if (
        sourceRead !== null &&
        sourceRead >= FLOW_DEADBAND_BPS &&
        destWrite !== null &&
        destWrite >= FLOW_DEADBAND_BPS
      ) {
        const copyRate = Math.min(sourceRead, destWrite);
        importCopyEmitted = true;
        flows.push(
          makeFlow("import-copy", downloadStorage, mediaStorage, {
            plane: "data",
            evidence: "derived",
            freshness: "live",
            channels: [{ direction: "forward", role: "write", bytesPerSecond: copyRate }],
            rate: transferRateAggregate([copyRate], "derived", "live"),
            provenance: `import in progress (${arrName}); rate derived from corroborating ${downloadStorage.name} source reads and ${mediaStorage.name} destination writes`,
            label: "import copy between pools",
            updatedAt: earliestUpdatedAt(
              src.updatedAt,
              snapshot.telemetry.disk.updatedAt,
            ),
            controllerServiceId: arr,
          }),
        );
        explicitImportPools.add(downloadStorage.name);
        explicitImportPools.add(mediaStorage.name);
      }
    }
  }

  // --- generic background storage transfer ---------------------------------
  // A named storage↔storage flow with no explicit controller is only credible
  // when one remaining real ZFS pool overwhelmingly dominates reads and a
  // different one overwhelmingly dominates writes. Directions already claimed
  // by download, playback, or explicit-import semantics are removed first so
  // known activity cannot be reinterpreted as an unrelated copy. A stale disk
  // domain retains the last supportable pair as a frozen observation.
  const resolvedPlayback = resolveJellyfinPlayback(snapshot, now);
  const backgroundReadExcludedPools = new Set(explicitImportPools);
  const backgroundWriteExcludedPools = new Set(explicitImportPools);
  if (qb.usable && downloadStorage.kind === "pool") {
    if (acq.rollup.downloading > 0) {
      backgroundWriteExcludedPools.add(downloadStorage.name);
    }
    if ((acq.rollup.seeding ?? 0) > 0) {
      backgroundReadExcludedPools.add(downloadStorage.name);
    }
  }
  if (resolvedPlayback && mediaStorage.kind === "pool") {
    backgroundReadExcludedPools.add(mediaStorage.name);
  }

  const backgroundReader = dominantNamedPoolCandidate(
    snapshot,
    "readBps",
    backgroundReadExcludedPools,
  );
  const backgroundWriter = dominantNamedPoolCandidate(
    snapshot,
    "writeBps",
    backgroundWriteExcludedPools,
  );
  if (
    backgroundReader &&
    backgroundWriter &&
    backgroundReader.pool !== backgroundWriter.pool
  ) {
    const backgroundFreshness: FlowFreshness =
      snapshot.telemetry.disk.status === "stale" ? "stale" : "live";
    const copyRate = Math.min(
      backgroundReader.bytesPerSecond,
      backgroundWriter.bytesPerSecond,
    );
    flows.push(
      makeFlow(
        "background-transfer",
        { kind: "pool", name: backgroundReader.pool },
        { kind: "pool", name: backgroundWriter.pool },
        {
          plane: "data",
          evidence: "derived",
          freshness: backgroundFreshness,
          channels: [{ direction: "forward", role: "write", bytesPerSecond: copyRate }],
          rate: transferRateAggregate([copyRate], "derived", backgroundFreshness),
          provenance: `derived from dominant ${backgroundReader.pool} source reads and ${backgroundWriter.pool} destination writes; no importing controller attributed`,
          label: "background storage transfer",
          updatedAt: snapshot.telemetry.disk.updatedAt,
        },
      ),
    );
  }

  // --- playback: media storage → Jellyfin → network --------------------------
  // Only ACTIVELY PLAYING sessions justify playback/egress flows. A paused
  // session is preserved in detail surfaces but draws nothing: no data
  // tunnel, no state-only breathing path, no service glow. When every session
  // is paused, no session-derived storage or egress rate is emitted at all —
  // positive mapped-container egress in that state remains visible as
  // measured container activity on the container body, but it is not
  // attributed to playback without corroborating playing sessions.
  if (resolvedPlayback) {
    const playingSessions = resolvedPlayback.playing;
    const { egress, playback, egressFreshness, playbackFreshness } = resolvedPlayback;
    const egressRate = egress.headline;
    const playbackRate = playback.headline;
    const transcoding = resolvedPlayback.transcodingCount > 0;
    const label =
      playingSessions.length > 1
        ? `Jellyfin playback · ${playingSessions.length} sessions`
        : transcoding
          ? "Jellyfin transcode"
          : "Jellyfin direct play";
    flows.push(
      makeFlow("playback", mediaStorage, { kind: "service", id: "jellyfin" }, {
        plane: "data",
        // The storage→Jellyfin PATH is always a derived attribution, even
        // when the rate itself is measured container block I/O: Docker
        // counters prove the container read blocks, not which pool supplied
        // them (no mount/device/pool mapping is verified). The rate keeps
        // its own measured evidence; the flow does not claim an exact
        // measured pool flow (V2.1 attribution blocker).
        evidence: playbackRate.knownBytesPerSecond === null ? "state-only" : "derived",
        freshness: playbackFreshness,
        channels: [{
          direction: "forward",
          role: "read",
          bytesPerSecond: playbackRate.knownBytesPerSecond,
        }],
        rate: { ...playbackRate, freshness: playbackFreshness },
        supportingRates: playback.supporting,
        provenance:
          playbackRate.basis === "container-block-read"
            ? `measured Jellyfin container block reads, attributed to ${
                mediaStorage.kind === "pool" ? mediaStorage.name : "storage"
              } by declared configuration (pool mapping not device-verified); cache and ARC may still serve media without disk I/O`
            : playbackRate.knownBytesPerSecond !== null
              ? "derived media demand from available Jellyfin session rates; cache and ARC may satisfy reads"
              : "playback reported by Jellyfin; storage rate unavailable",
        label,
        updatedAt:
          playbackRate.basis === "container-block-read"
            ? snapshot.telemetry.docker.updatedAt
            : resolvedPlayback.connectorUpdatedAt,
      }),
    );
    flows.push(
      makeFlow("egress", { kind: "service", id: "jellyfin" }, { kind: "network" }, {
        plane: "data",
        evidence:
          egressRate.knownBytesPerSecond === null
            ? "state-only"
            : egressRate.basis === "container-egress"
              ? "measured"
              : "derived",
        freshness: egressFreshness,
        channels: [{
          direction: "forward",
          role: "egress",
          bytesPerSecond: egressRate.knownBytesPerSecond,
        }],
        rate: { ...egressRate, freshness: egressFreshness },
        supportingRates: egress.supporting,
        provenance:
          egressRate.basis === "container-egress"
            ? "measured Jellyfin container egress; not an exact per-session bitrate"
            : egressRate.knownBytesPerSecond !== null
              ? "aggregated from available Jellyfin session rate observations"
              : "playback reported by Jellyfin; egress rate unavailable",
        label,
        updatedAt:
          egressRate.basis === "container-egress"
            ? snapshot.telemetry.docker.updatedAt
            : resolvedPlayback.connectorUpdatedAt,
      }),
    );
  }

  return flows;
}

/**
 * The strongest data-plane byte rate on an observation (max across channels),
 * or null when no channel carries a known rate. Used for hover text and to
 * seed width targets — control-plane observations always return null.
 */
export function primaryRate(obs: FlowObservation): number | null {
  if (obs.plane !== "data") return null;
  let max: number | null = null;
  for (const ch of obs.channels) {
    if (ch.bytesPerSecond === null) continue;
    if (max === null || ch.bytesPerSecond > max) max = ch.bytesPerSecond;
  }
  return max;
}

/**
 * Whether a numerically-zero aggregate is an AUTHORITATIVE zero: every
 * contributor is accounted for (complete coverage, no unknown contributors)
 * and real evidence backs the value. A known zero under partial/unknown
 * coverage is a LOWER BOUND — "at least 0 B/s" — which says nothing about the
 * total rate and must never be rendered as a confirmed zero.
 */
export function isAuthoritativeZero(rate: AggregateRateObservation): boolean {
  return (
    rate.knownBytesPerSecond === 0 &&
    rate.unknownContributors === 0 &&
    rate.coverage === "complete" &&
    rate.evidence !== null
  );
}

/**
 * The truth classification every renderer's rate treatment must derive from.
 * No renderer may re-infer these semantics from the numeric rate alone —
 * the number loses coverage information (a partial known-zero and a complete
 * measured zero are both `0`).
 */
export type FlowRateClass =
  /** The justifying source is stale: freeze, regardless of numeric value. */
  | "stale"
  /** A known positive rate (a lower bound when coverage is partial). */
  | "positive"
  /** An authoritative zero: complete coverage, live, evidence-backed. */
  | "confirmed-zero"
  /** Work may exist but the total rate is unknown (includes partial zeros). */
  | "unknown";

/** Classify a flow's rate semantics from its authoritative aggregate. */
export function classifyFlowRate(flow: FlowObservation): FlowRateClass {
  if (flow.freshness === "stale") return "stale";
  if (flow.plane !== "data") return "unknown";
  const rate = primaryRate(flow);
  if (rate !== null && rate > 0) return "positive";
  if (
    rate === 0 &&
    flow.rate !== undefined &&
    flow.rate.freshness === "live" &&
    isAuthoritativeZero(flow.rate)
  ) {
    return "confirmed-zero";
  }
  // A numeric zero WITHOUT an aggregate proving completeness is never
  // promoted to confirmed-zero — completeness is declared, not inferred.
  return "unknown";
}

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
  const jellyfin = sourceState(snapshot, "jellyfin", now);
  const mediaStorage = mediaStorageEndpoint(snapshot);
  const downloadStorage = downloadStorageEndpoint(snapshot);

  // --- WAN ↔ downloader + downloader ↔ storage (data plane) -----------------
  if (qb.usable) {
    const downloadBps = rate(acq.rollup.aggregateRateBps);
    const uploadBps = rate(acq.rollup.uploadRateBps ?? null);
    const downloading =
      acq.rollup.downloading > 0 &&
      downloadBps !== null &&
      downloadBps >= FLOW_DEADBAND_BPS;
    const seeding =
      (acq.rollup.seeding ?? 0) > 0 &&
      uploadBps !== null &&
      uploadBps >= FLOW_DEADBAND_BPS;

    if (downloading || seeding) {
      // One shared WAN conduit; download and seed-upload are opposite
      // channels on it, each carrying its own measured rate.
      const channels: FlowChannel[] = [];
      if (downloading) {
        channels.push({ direction: "forward", role: "ingress", bytesPerSecond: downloadBps });
      }
      if (seeding) {
        channels.push({ direction: "reverse", role: "egress", bytesPerSecond: uploadBps });
      }
      flows.push(
        makeFlow("wan-transfer", { kind: "network" }, { kind: "service", id: "qbittorrent" }, {
          plane: "data",
          evidence: "measured",
          freshness: qb.freshness,
          channels,
          provenance: "measured by qBittorrent transfer counters",
          label:
            downloading && seeding
              ? "qBittorrent download + seed"
              : downloading
                ? "qBittorrent download"
                : "qBittorrent seeding",
          updatedAt: qb.updatedAt,
        }),
      );

      // The same bytes meet storage on the downloader's other side. The rates
      // are qBittorrent's transfer counters ATTRIBUTED to the storage hop, so
      // this is derived, not measured — ARC/page cache may absorb part of it.
      const storageChannels: FlowChannel[] = [];
      if (downloading) {
        storageChannels.push({ direction: "forward", role: "write", bytesPerSecond: downloadBps });
      }
      if (seeding) {
        storageChannels.push({ direction: "reverse", role: "read", bytesPerSecond: uploadBps });
      }
      flows.push(
        makeFlow("storage-transfer", { kind: "service", id: "qbittorrent" }, downloadStorage, {
          plane: "data",
          evidence: "derived",
          freshness: qb.freshness,
          channels: storageChannels,
          provenance:
            downloadStorage.kind === "pool"
              ? "derived from qBittorrent rates; destination declared by HOMELAB_DOWNLOAD_POOL"
              : "derived from qBittorrent rates; storage destination not declared",
          label: downloading ? "download landing on storage" : "seeding from storage",
          updatedAt: qb.updatedAt,
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
            provenance: `import in progress (${arrName}); rate derived from corroborating ${downloadStorage.name} source reads and ${mediaStorage.name} destination writes`,
            label: "import copy between pools",
            updatedAt: earliestUpdatedAt(
              src.updatedAt,
              snapshot.telemetry.disk.updatedAt,
            ),
          }),
        );
      }
    }
  }

  // --- playback: media storage → Jellyfin → network --------------------------
  // Only ACTIVELY PLAYING sessions justify playback/egress flows. A paused
  // session is preserved in detail surfaces but draws nothing: no data
  // tunnel, no state-only breathing path, no service glow. When every session
  // is paused, no session-derived storage or egress rate is emitted at all —
  // positive mapped-container egress in that state remains visible as
  // measured container activity on the container body, but it is not
  // attributed to playback without corroborating playing sessions.
  const sessions = snapshot.jellyfin.sessions;
  const playingSessions = sessions.filter((s) => !s.paused);
  if (jellyfin.usable && playingSessions.length > 0) {
    const sessionAggregate = sessionRateAggregate(playingSessions, jellyfin.freshness);
    const containerEgress = containerRate(snapshot, "netTxBps");
    const containerReads = containerRate(snapshot, "blockReadBps");
    const egress = pickHeadlineRate(containerEgress, sessionAggregate);
    const playback = pickHeadlineRate(
      containerReads,
      storageAttribution(sessionAggregate),
    );
    const egressRate = egress.headline;
    const playbackRate = playback.headline;
    const egressFreshness: FlowFreshness =
      jellyfin.freshness === "stale" || egressRate.freshness === "stale"
        ? "stale"
        : "live";
    const playbackFreshness: FlowFreshness =
      jellyfin.freshness === "stale" || playbackRate.freshness === "stale"
        ? "stale"
        : "live";
    const transcoding = playingSessions.some((s) => s.method === "transcode");
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
            : jellyfin.updatedAt,
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
            : jellyfin.updatedAt,
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

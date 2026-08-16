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
import type { DashboardSnapshot } from "@/lib/types";

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
  const sessions = snapshot.jellyfin.sessions;
  if (jellyfin.usable && sessions.length > 0) {
    const bitrateKnown = sessions.every((s) => s.bitrateBps !== null);
    const totalBps = bitrateKnown
      ? sessions.reduce((sum, s) => sum + (s.bitrateBps ?? 0), 0) / 8
      : null;
    const transcoding = sessions.some((s) => s.method === "transcode");
    const label =
      sessions.length > 1
        ? `Jellyfin playback · ${sessions.length} sessions`
        : transcoding
          ? "Jellyfin transcode"
          : "Jellyfin direct play";
    // Session bitrate is a real measurement of the STREAM; using it for the
    // storage read leg is an attribution (ARC/caching may serve part of it).
    flows.push(
      makeFlow("playback", mediaStorage, { kind: "service", id: "jellyfin" }, {
        plane: "data",
        evidence: bitrateKnown ? "derived" : "state-only",
        freshness: jellyfin.freshness,
        channels: [{ direction: "forward", role: "read", bytesPerSecond: totalBps }],
        provenance: bitrateKnown
          ? "derived from Jellyfin session bitrate (cache may serve part of the reads)"
          : "session state reported by Jellyfin; one or more session bitrates unavailable",
        label,
        updatedAt: jellyfin.updatedAt,
      }),
    );
    flows.push(
      makeFlow("egress", { kind: "service", id: "jellyfin" }, { kind: "network" }, {
        plane: "data",
        evidence: bitrateKnown ? "derived" : "state-only",
        freshness: jellyfin.freshness,
        channels: [{ direction: "forward", role: "egress", bytesPerSecond: totalBps }],
        provenance: bitrateKnown
          ? "derived from Jellyfin session bitrate"
          : "session state reported by Jellyfin; one or more session bitrates unavailable",
        label,
        updatedAt: jellyfin.updatedAt,
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

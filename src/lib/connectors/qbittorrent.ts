/**
 * qBittorrent connector (PLA-183) — read-only, privacy-first.
 *
 * The Web API's `torrents/info` returns trackers, save paths, peer counts, and
 * more. We deliberately pick ONLY the pipeline fields (name, progress, speed,
 * eta, state) into `AcquisitionItem` — trackers/paths/peers are never read or
 * emitted, so private torrent metadata cannot leak to the client by
 * construction.
 *
 * Auth (cookie login) is stateful and lives in the injected `QbClient` (the
 * real, `server-only` implementation is wired by the registry, PLA-186); the
 * normalizer here is pure and unit-tested against fixtures.
 */

import { z } from "zod";
import { parseUpstream } from "@/lib/connectors/validate";
import type { Connector } from "@/lib/connectors/connector";
import { clamp, opaqueId } from "@/lib/utils";
import type {
  AcquisitionItem,
  AcquisitionSnapshot,
  AcquisitionState,
} from "@/lib/types";

// Only safe fields are declared; `.passthrough()` tolerates (and ignores) the
// rest (trackers, save_path, etc.).
const torrentSchema = z
  .object({
    hash: z.string().optional(),
    name: z.string().optional(),
    progress: z.number().optional(),
    dlspeed: z.number().optional(),
    upspeed: z.number().optional(),
    eta: z.number().optional(),
    state: z.string().optional(),
  })
  .passthrough();

export const qbTorrentsSchema = z.array(torrentSchema);
export const qbTransferSchema = z
  .object({
    dl_info_speed: z.number().optional(),
    up_info_speed: z.number().optional(),
  })
  .passthrough();

type RawTorrent = z.infer<typeof torrentSchema>;

/** qBittorrent's "infinity" ETA sentinel. */
const ETA_INFINITY = 8_640_000;

export function mapQbState(state: string | undefined, dlspeed: number): AcquisitionState {
  switch (state) {
    case "error":
    case "missingFiles":
      return "failed";
    case "stalledDL":
      // Truly stalled (no peers / 0 speed) vs a merely slow transfer: only 0
      // throughput counts as stalled; a slow-but-moving transfer stays
      // "downloading". Time-based stall grace/hysteresis lives in the
      // attention engine (PLA-189).
      return dlspeed > 0 ? "downloading" : "stalled";
    case "downloading":
    case "forcedDL":
      return "downloading";
    case "metaDL":
    case "queuedDL":
    case "checkingDL":
    case "pausedDL":
    case "stoppedDL":
      return "searching";
    default:
      // uploading / stalledUP / pausedUP / queuedUP / checkingUP / forcedUP …
      return "completed";
  }
}

function rollup(
  items: AcquisitionItem[],
  globalRateBps: number | null,
  upload: { rateBps: number | null; seeding: number },
): AcquisitionSnapshot["rollup"] {
  const aggregate =
    globalRateBps ?? items.reduce((sum, i) => sum + (i.rateBps ?? 0), 0);
  return {
    downloading: items.filter((i) => i.state === "downloading").length,
    importing: items.filter((i) => i.state === "importing").length,
    failedOrStalled: items.filter((i) => i.state === "stalled" || i.state === "failed").length,
    aggregateRateBps: Math.max(0, Math.round(aggregate)),
    // Upload telemetry (PLA-267 seeding flows): the global transfer-info rate
    // when reported, else the per-torrent sum when torrents carried upspeed,
    // else null — an unknown upload rate must never render as a confirmed 0.
    uploadRateBps: upload.rateBps === null ? null : Math.max(0, Math.round(upload.rateBps)),
    seeding: upload.seeding,
  };
}

function normalizeTorrent(raw: RawTorrent, index: number): AcquisitionItem {
  const dlspeed = raw.dlspeed ?? 0;
  const state = mapQbState(raw.state, dlspeed);
  const eta = raw.eta;
  // Never expose the raw infohash as a browser-visible id. The opaque, stable
  // key (a one-way fold of the case-normalized hash) doubles as the id and the
  // cross-service correlation key with Sonarr/Radarr (which key on the same
  // infohash via their downloadId).
  const key = raw.hash ? opaqueId(raw.hash.toLowerCase()) : null;
  return {
    id: key ? `qbittorrent-${key}` : `qbittorrent-${index}`,
    source: "qbittorrent",
    title: raw.name ?? "Unknown",
    quality: null,
    state,
    progress: clamp(raw.progress ?? 0, 0, 1),
    rateBps: state === "downloading" ? dlspeed : dlspeed > 0 ? dlspeed : 0,
    etaSeconds: eta == null || eta >= ETA_INFINITY ? null : eta,
    correlationKey: key,
  };
}

/** qB states that mean the torrent is in its seeding lifecycle. */
const SEED_STATES = new Set([
  "uploading",
  "forcedUP",
  "stalledUP",
  "queuedUP",
  "checkingUP",
]);

export function normalizeQbittorrent(input: {
  torrents: unknown;
  transfer?: unknown;
}): AcquisitionSnapshot {
  const torrents = parseUpstream(qbTorrentsSchema, input.torrents, "qbittorrent.torrents");
  const transfer = input.transfer
    ? parseUpstream(qbTransferSchema, input.transfer, "qbittorrent.transfer")
    : null;

  const items = torrents.map(normalizeTorrent);
  // Actively seeding = in a seed state AND moving bytes right now.
  const seeding = torrents.filter(
    (t) => SEED_STATES.has(t.state ?? "") && (t.upspeed ?? 0) > 0,
  ).length;
  const upspeedSum = torrents.some((t) => typeof t.upspeed === "number")
    ? torrents.reduce((sum, t) => sum + (t.upspeed ?? 0), 0)
    : null;
  const uploadRateBps = transfer?.up_info_speed ?? upspeedSum;
  return {
    items,
    rollup: rollup(items, transfer?.dl_info_speed ?? null, {
      rateBps: uploadRateBps,
      seeding,
    }),
  };
}

// --- connector factory ------------------------------------------------------

/** Session-aware client (handles cookie login); real impl is server-only. */
export interface QbClient {
  torrentsInfo(signal: AbortSignal): Promise<unknown>;
  transferInfo(signal: AbortSignal): Promise<unknown>;
}

export function createQbittorrentConnector(
  cfg: { pollIntervalMs: number },
  client: QbClient,
): Connector<AcquisitionSnapshot> {
  return {
    id: "qbittorrent",
    pollIntervalMs: cfg.pollIntervalMs,
    async poll(signal) {
      const [torrents, transfer] = await Promise.all([
        client.torrentsInfo(signal),
        client.transferInfo(signal),
      ]);
      return normalizeQbittorrent({ torrents, transfer });
    },
  };
}

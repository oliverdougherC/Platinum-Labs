/**
 * Shared Sonarr/Radarr (*arr) connector logic (PLA-181 / PLA-182).
 *
 * Sonarr and Radarr expose the same `/api/v3/queue` shape, so both normalize
 * through one pure function into the shared media-pipeline `AcquisitionItem`
 * type. Two thin factories differ only in `id`, title strategy, and auth header.
 */

import { z } from "zod";
import { parseUpstream } from "@/lib/connectors/validate";
import type { Connector } from "@/lib/connectors/connector";
import type { HttpGet } from "@/lib/connectors/jellyfin";
import { clamp, opaqueId } from "@/lib/utils";
import type {
  AcquisitionItem,
  AcquisitionState,
  ServarrHistoryEvent,
  ServarrSnapshot,
} from "@/lib/types";

const qualityShape = z
  .object({ quality: z.object({ name: z.string().optional() }).passthrough().optional() })
  .passthrough();
const seriesShape = z.object({ title: z.string().optional() }).passthrough();
const movieShape = z.object({ title: z.string().optional() }).passthrough();
const episodeShape = z
  .object({
    seasonNumber: z.number().optional(),
    episodeNumber: z.number().optional(),
    title: z.string().optional(),
  })
  .passthrough();

const queueRecordSchema = z
  .object({
    id: z.union([z.number(), z.string()]).optional(),
    title: z.string().optional(),
    status: z.string().optional(),
    trackedDownloadState: z.string().optional(),
    trackedDownloadStatus: z.string().optional(),
    size: z.number().optional(),
    sizeleft: z.number().optional(),
    timeleft: z.string().optional(),
    errorMessage: z.string().optional(),
    // The download-client identifier. For torrents this is the (uppercase)
    // infohash; used ONLY server-side to correlate with the qBittorrent transfer.
    downloadId: z.string().optional(),
    quality: qualityShape.optional(),
    series: seriesShape.optional(),
    movie: movieShape.optional(),
    episode: episodeShape.optional(),
  })
  .passthrough();

export const servarrQueueSchema = z
  .object({ records: z.array(queueRecordSchema).optional() })
  .passthrough();

type RawRecord = z.infer<typeof queueRecordSchema>;

// --- history schema ---------------------------------------------------------

const historyRecordSchema = z
  .object({
    id: z.union([z.number(), z.string()]).optional(),
    date: z.string().optional(),
    eventType: z.union([z.string(), z.number()]).optional(),
    downloadId: z.string().optional(),
    sourceTitle: z.string().optional(),
    quality: qualityShape.optional(),
    series: seriesShape.optional(),
    movie: movieShape.optional(),
    episode: episodeShape.optional(),
  })
  .passthrough();

export const servarrHistorySchema = z
  .object({
    page: z.number().optional(),
    pageSize: z.number().optional(),
    totalRecords: z.number().optional(),
    records: z.array(historyRecordSchema).optional(),
  })
  .passthrough();

type RawHistoryRecord = z.infer<typeof historyRecordSchema>;

/** Bounded lookback window: history older than this is never re-scanned. */
const HISTORY_LOOKBACK_MS = 6 * 3_600_000; // 6h
/** Records per history page. */
const HISTORY_PAGE_SIZE = 50;
/** Hard cap on pages fetched per poll (bounds work regardless of volume). */
const HISTORY_MAX_PAGES = 10;

/** Opaque correlation key from an infohash-like download id (case-normalized). */
function correlationKeyFor(downloadId: string | undefined): string | null {
  if (!downloadId) return null;
  return opaqueId(downloadId.toLowerCase());
}

/** Parse a Sonarr/Radarr `timeleft` string (`[d.]hh:mm:ss`) into seconds. */
export function parseTimeleft(value: string | undefined): number | null {
  if (!value) return null;
  const [dayPart, clockPart] = value.includes(".")
    ? value.split(".")
    : [null, value];
  const segments = (clockPart ?? "").split(":").map(Number);
  if (segments.length !== 3 || segments.some((n) => Number.isNaN(n))) return null;
  const [h, m, s] = segments as [number, number, number];
  const days = dayPart ? Number(dayPart) : 0;
  if (Number.isNaN(days)) return null;
  return days * 86_400 + h * 3_600 + m * 60 + s;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function mapServarrState(raw: RawRecord): AcquisitionState {
  const status = (raw.status ?? "").toLowerCase();
  const tracked = (raw.trackedDownloadState ?? "").toLowerCase();
  const trackedStatus = (raw.trackedDownloadStatus ?? "").toLowerCase();

  if (status === "completed" && tracked === "imported") return "completed";
  if (tracked.includes("import")) return "importing";
  if (status === "failed" || trackedStatus === "error" || tracked.includes("failed"))
    return "failed";
  if (status === "warning" || tracked === "stalled") return "stalled";
  if (status === "downloading" || tracked === "downloading") return "downloading";
  return "searching";
}

function buildTitle(raw: RawRecord, source: "sonarr" | "radarr"): string {
  if (source === "sonarr" && raw.series?.title) {
    const ep = raw.episode;
    if (ep?.seasonNumber != null && ep.episodeNumber != null) {
      return `${raw.series.title} — S${pad2(ep.seasonNumber)}E${pad2(ep.episodeNumber)}`;
    }
    return raw.series.title;
  }
  if (source === "radarr" && raw.movie?.title) return raw.movie.title;
  return raw.title ?? "Unknown";
}

export function normalizeServarrQueue(
  raw: unknown,
  source: "sonarr" | "radarr",
  label = source,
): AcquisitionItem[] {
  const parsed = parseUpstream(servarrQueueSchema, raw, label);
  const records = parsed.records ?? [];

  return records.map((rec, i): AcquisitionItem => {
    const size = rec.size ?? 0;
    const left = rec.sizeleft ?? 0;
    const progress = size > 0 ? clamp((size - left) / size, 0, 1) : 0;
    return {
      id: `${source}-${rec.id ?? i}`,
      source,
      title: buildTitle(rec, source),
      quality: rec.quality?.quality?.name ?? null,
      state: mapServarrState(rec),
      progress,
      // *arr queue doesn't expose a reliable instantaneous rate; qBittorrent does.
      rateBps: null,
      etaSeconds: parseTimeleft(rec.timeleft),
      correlationKey: correlationKeyFor(rec.downloadId),
    };
  });
}

// --- history normalization --------------------------------------------------

/**
 * Map a raw history `eventType` to a normalized event kind, or null to ignore
 * it. Sonarr/Radarr use string event types (a few numeric in old versions);
 * import events represent acquisition completion, failures the error path.
 * Grabbed/deleted/renamed/ignored are intentionally dropped (queue already shows
 * in-progress work; the rest is noise).
 */
function mapHistoryKind(
  eventType: string | number | undefined,
): ServarrHistoryEvent["kind"] | null {
  const t = String(eventType ?? "").toLowerCase();
  if (t.includes("import")) return "media.imported";
  if (t.includes("fail")) return "transfer.failed";
  return null;
}

function buildHistoryTitle(rec: RawHistoryRecord, source: "sonarr" | "radarr"): string {
  if (source === "sonarr" && rec.series?.title) {
    const ep = rec.episode;
    if (ep?.seasonNumber != null && ep.episodeNumber != null) {
      return `${rec.series.title} — S${pad2(ep.seasonNumber)}E${pad2(ep.episodeNumber)}`;
    }
    return rec.series.title;
  }
  if (source === "radarr" && rec.movie?.title) return rec.movie.title;
  return rec.sourceTitle ?? "Unknown";
}

interface ParsedHistoryPage {
  events: ServarrHistoryEvent[];
  /** Oldest record date on the page (epoch ms), across ALL records, or null. */
  oldestAt: number | null;
  /** Total records on the page (relevant or not) — used to detect the last page. */
  count: number;
}

/** Validate + normalize one history page. Tolerates missing metadata safely. */
function parseHistoryPage(raw: unknown, source: "sonarr" | "radarr"): ParsedHistoryPage {
  const parsed = parseUpstream(servarrHistorySchema, raw, `${source}.history`);
  const records = parsed.records ?? [];
  const events: ServarrHistoryEvent[] = [];
  let oldestAt: number | null = null;

  for (const rec of records) {
    const at = rec.date ? Date.parse(rec.date) : Number.NaN;
    if (!Number.isNaN(at)) oldestAt = oldestAt === null ? at : Math.min(oldestAt, at);

    const kind = mapHistoryKind(rec.eventType);
    if (!kind || Number.isNaN(at)) continue; // undated/irrelevant → skip safely
    events.push({
      id: `${source}-history-${rec.id ?? `${kind}-${at}`}`,
      source,
      kind,
      at,
      title: buildHistoryTitle(rec, source),
      quality: rec.quality?.quality?.name ?? null,
    });
  }
  return { events, oldestAt, count: records.length };
}

/** Validate + normalize a single history response (one page). */
export function normalizeServarrHistory(
  raw: unknown,
  source: "sonarr" | "radarr",
): ServarrHistoryEvent[] {
  return parseHistoryPage(raw, source).events;
}

export interface HistoryFetchOptions {
  http: HttpGet;
  /** Base URL with no trailing slash. */
  base: string;
  headers: Record<string, string>;
  source: "sonarr" | "radarr";
  signal: AbortSignal;
  now: number;
  lookbackMs?: number;
  pageSize?: number;
  maxPages?: number;
}

/**
 * Fetch recent history with safe pagination, an overlapping bounded window, and
 * stable per-record dedup. Descending-by-date pages are fetched until the window
 * is fully covered (an older-than-window page, a short last page, or the page
 * cap). Events are deduped by their stable id, so overlapping windows across
 * polls never double-count. Returns oldest-first.
 */
export async function collectServarrHistory(
  opts: HistoryFetchOptions,
): Promise<ServarrHistoryEvent[]> {
  const { http, base, headers, source, signal, now } = opts;
  const lookbackMs = opts.lookbackMs ?? HISTORY_LOOKBACK_MS;
  const pageSize = opts.pageSize ?? HISTORY_PAGE_SIZE;
  const maxPages = opts.maxPages ?? HISTORY_MAX_PAGES;
  const windowStart = now - lookbackMs;

  const byId = new Map<string, ServarrHistoryEvent>();
  for (let page = 1; page <= maxPages; page++) {
    const url =
      `${base}/api/v3/history?page=${page}&pageSize=${pageSize}` +
      `&sortKey=date&sortDirection=descending` +
      `&includeSeries=true&includeEpisode=true&includeMovie=true`;
    const raw = await http(url, { signal, headers, label: `${source}.history` });
    const { events, oldestAt, count } = parseHistoryPage(raw, source);

    for (const ev of events) {
      if (ev.at >= windowStart) byId.set(ev.id, ev);
    }

    // Stop when the page is the last one, or it has already crossed the window.
    if (count < pageSize) break;
    if (oldestAt !== null && oldestAt < windowStart) break;
  }

  return [...byId.values()].sort((a, b) => a.at - b.at);
}

function makeServarrConnector(
  source: "sonarr" | "radarr",
  cfg: { url: string; apiKey: string; pollIntervalMs: number },
  http: HttpGet,
  now: () => number = Date.now,
): Connector<ServarrSnapshot> {
  const base = cfg.url.replace(/\/$/, "");
  const headers = { "X-Api-Key": cfg.apiKey, Accept: "application/json" };
  return {
    id: source,
    pollIntervalMs: cfg.pollIntervalMs,
    async poll(signal) {
      // Queue is authoritative for active items and must not be lost if the
      // history path degrades (PLA-181).
      const rawQueue = await http(
        `${base}/api/v3/queue?pageSize=50&includeUnknownItems=false`,
        { signal, headers, label: source },
      );
      const items = normalizeServarrQueue(rawQueue, source);

      let events: ServarrHistoryEvent[] = [];
      try {
        events = await collectServarrHistory({ http, base, headers, source, signal, now: now() });
      } catch (err) {
        // History is best-effort: an isolated history failure must not discard
        // valid queue data. The overlapping window re-fetches on recovery. A true
        // whole-poll timeout still surfaces via the runtime's timeout race, so
        // swallowing here can't mask a real connector outage. Log sanitized only.
        console.warn(
          `[${source}] history poll degraded: ${err instanceof Error ? err.name : "error"}`,
        );
      }

      return { items, events };
    },
  };
}

export function createSonarrConnector(
  cfg: { url: string; apiKey: string; pollIntervalMs: number },
  http: HttpGet,
  now: () => number = Date.now,
): Connector<ServarrSnapshot> {
  return makeServarrConnector("sonarr", cfg, http, now);
}

export function createRadarrConnector(
  cfg: { url: string; apiKey: string; pollIntervalMs: number },
  http: HttpGet,
  now: () => number = Date.now,
): Connector<ServarrSnapshot> {
  return makeServarrConnector("radarr", cfg, http, now);
}

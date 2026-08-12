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
import { clamp } from "@/lib/utils";
import type { AcquisitionItem, AcquisitionState } from "@/lib/types";

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
    quality: z
      .object({ quality: z.object({ name: z.string().optional() }).passthrough().optional() })
      .passthrough()
      .optional(),
    series: z.object({ title: z.string().optional() }).passthrough().optional(),
    movie: z.object({ title: z.string().optional() }).passthrough().optional(),
    episode: z
      .object({
        seasonNumber: z.number().optional(),
        episodeNumber: z.number().optional(),
        title: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const servarrQueueSchema = z
  .object({ records: z.array(queueRecordSchema).optional() })
  .passthrough();

type RawRecord = z.infer<typeof queueRecordSchema>;

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
    };
  });
}

function makeServarrConnector(
  source: "sonarr" | "radarr",
  cfg: { url: string; apiKey: string; pollIntervalMs: number },
  http: HttpGet,
): Connector<AcquisitionItem[]> {
  const base = cfg.url.replace(/\/$/, "");
  const headers = { "X-Api-Key": cfg.apiKey, Accept: "application/json" };
  return {
    id: source,
    pollIntervalMs: cfg.pollIntervalMs,
    async poll(signal) {
      const raw = await http(`${base}/api/v3/queue?pageSize=50&includeUnknownItems=false`, {
        signal,
        headers,
        label: source,
      });
      return normalizeServarrQueue(raw, source);
    },
  };
}

export function createSonarrConnector(
  cfg: { url: string; apiKey: string; pollIntervalMs: number },
  http: HttpGet,
): Connector<AcquisitionItem[]> {
  return makeServarrConnector("sonarr", cfg, http);
}

export function createRadarrConnector(
  cfg: { url: string; apiKey: string; pollIntervalMs: number },
  http: HttpGet,
): Connector<AcquisitionItem[]> {
  return makeServarrConnector("radarr", cfg, http);
}

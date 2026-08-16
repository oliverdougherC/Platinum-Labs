/**
 * Jellyfin connector (PLA-180) — read-only.
 *
 * Structure shared by every real connector:
 *   - a Zod schema for the upstream payload (validated at the boundary),
 *   - a PURE `normalize()` that maps validated data → the domain snapshot,
 *   - a factory that wires them into a `Connector<T>` using an INJECTED http
 *     function (so this module stays free of `server-only`/network and the
 *     normalizer is unit-tested against fixtures).
 *
 * The real `http` (server-only `fetchJson`) is injected by the connector
 * registry (PLA-186).
 */

import { z } from "zod";
import { parseUpstream } from "@/lib/connectors/validate";
import type { Connector } from "@/lib/connectors/connector";
import { clamp } from "@/lib/utils";
import type {
  JellyfinSession,
  JellyfinSnapshot,
  PlaybackMethod,
  RateObservation,
} from "@/lib/types";

// --- upstream schemas (lenient: tolerate the many fields we don't use) ------

export const jellyfinSystemSchema = z
  .object({ Version: z.string().optional() })
  .passthrough();

const sessionSchema = z
  .object({
    Id: z.string().optional(),
    UserName: z.string().optional(),
    NowPlayingItem: z
      .object({
        Name: z.string().optional(),
        SeriesName: z.string().optional(),
        IndexNumber: z.number().optional(),
        ParentIndexNumber: z.number().optional(),
        RunTimeTicks: z.number().optional(),
        Height: z.number().optional(),
        Bitrate: z.number().nullish(),
        Type: z.string().optional(),
      })
      .passthrough()
      .optional(),
    PlayState: z
      .object({
        PositionTicks: z.number().optional(),
        PlayMethod: z.string().optional(),
        IsPaused: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    TranscodingInfo: z
      .object({ Bitrate: z.number().optional() })
      .passthrough()
      .optional(),
    MediaSource: z
      .object({ Bitrate: z.number().nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export const jellyfinSessionsSchema = z.array(sessionSchema);

type RawSession = z.infer<typeof sessionSchema>;

// --- normalization (pure) ---------------------------------------------------

function mapPlayMethod(raw: string | undefined): PlaybackMethod {
  switch (raw) {
    case "DirectStream":
      return "direct-stream";
    case "Transcode":
      return "transcode";
    default:
      return "direct-play";
  }
}

export function resolutionFromHeight(height: number | undefined): string | null {
  if (!height) return null;
  if (height >= 2000) return "4K";
  if (height >= 1400) return "1440p";
  if (height >= 1000) return "1080p";
  if (height >= 700) return "720p";
  return `${height}p`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function bytesPerSecond(bitsPerSecond: number | null | undefined): number | null {
  return typeof bitsPerSecond === "number" && Number.isFinite(bitsPerSecond) && bitsPerSecond > 0
    ? bitsPerSecond / 8
    : null;
}

function sessionRate(raw: RawSession, method: PlaybackMethod): RateObservation | null {
  const output = bytesPerSecond(raw.TranscodingInfo?.Bitrate);
  if (output !== null) {
    return {
      bytesPerSecond: output,
      basis: "jellyfin-session-output",
      evidence: "reported",
    };
  }

  // Jellyfin may omit output/target rate while still reporting source-media
  // bitrate. It is useful evidence, but never measured egress. Only DIRECT
  // PLAY sends the source bytes as-is (reported); a transcode obviously
  // re-encodes, and a DIRECT STREAM remuxes into a different container, so
  // for both the source-media bitrate is an ESTIMATE of the output rate.
  const source = bytesPerSecond(
    raw.MediaSource?.Bitrate ?? raw.NowPlayingItem?.Bitrate,
  );
  if (source === null) return null;
  return {
    bytesPerSecond: source,
    basis: "source-media",
    evidence: method === "direct-play" ? "reported" : "estimated",
  };
}

function normalizeSession(raw: RawSession, index: number): JellyfinSession | null {
  const item = raw.NowPlayingItem;
  if (!item) return null; // session exists but nothing is playing

  const isEpisode = Boolean(item.SeriesName);
  const title = isEpisode ? item.SeriesName! : (item.Name ?? "Unknown");
  const subtitle =
    isEpisode && item.ParentIndexNumber != null && item.IndexNumber != null
      ? `S${pad2(item.ParentIndexNumber)}E${pad2(item.IndexNumber)} — ${item.Name ?? ""}`.trim()
      : null;

  const runtime = item.RunTimeTicks ?? 0;
  const position = raw.PlayState?.PositionTicks ?? 0;
  const progress = runtime > 0 ? clamp(position / runtime, 0, 1) : 0;

  const method = mapPlayMethod(raw.PlayState?.PlayMethod);
  return {
    id: raw.Id ?? `session-${index}`,
    user: raw.UserName ?? "unknown",
    title,
    subtitle,
    method,
    // Reported player state only. An absent IsPaused means "not reported
    // paused" → playing; pause is never inferred from a missing/zero rate.
    paused: raw.PlayState?.IsPaused === true,
    progress,
    resolution: resolutionFromHeight(item.Height),
    rate: sessionRate(raw, method),
  };
}

export function normalizeJellyfin(
  input: { system: unknown; sessions: unknown },
  now: number,
): JellyfinSnapshot {
  const system = parseUpstream(jellyfinSystemSchema, input.system, "jellyfin.system");
  const rawSessions = parseUpstream(
    jellyfinSessionsSchema,
    input.sessions,
    "jellyfin.sessions",
  );

  const sessions = rawSessions
    .map((s, i) => normalizeSession(s, i))
    .filter((s): s is JellyfinSession => s !== null);

  return {
    serverAvailable: true,
    version: system.Version ?? null,
    sessions,
    lastPlaybackAt: sessions.length > 0 ? now : null,
  };
}

// --- connector factory ------------------------------------------------------

export type HttpGet = (
  url: string,
  opts: { signal: AbortSignal; headers?: Record<string, string>; label?: string },
) => Promise<unknown>;

export interface JellyfinConfig {
  url: string;
  apiKey: string;
  pollIntervalMs: number;
}

export function createJellyfinConnector(
  cfg: JellyfinConfig,
  http: HttpGet,
  now: () => number = Date.now,
): Connector<JellyfinSnapshot> {
  const headers = { "X-Emby-Token": cfg.apiKey, Accept: "application/json" };
  const base = cfg.url.replace(/\/$/, "");
  return {
    id: "jellyfin",
    pollIntervalMs: cfg.pollIntervalMs,
    async poll(signal) {
      const [system, sessions] = await Promise.all([
        http(`${base}/System/Info`, { signal, headers, label: "jellyfin" }),
        http(`${base}/Sessions`, { signal, headers, label: "jellyfin" }),
      ]);
      return normalizeJellyfin({ system, sessions }, now());
    },
  };
}

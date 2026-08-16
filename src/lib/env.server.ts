import "server-only";

import { z } from "zod";

/**
 * Server-only environment parsing — the single typed source of truth for every
 * server-side setting (PLA-193 config consolidation).
 *
 * The `server-only` import above makes this module a build error if it is ever
 * pulled into a client component graph — enforcing the spec's hard boundary:
 * "Never expose service API keys ... to the browser."
 *
 * Secrets are optional so the app boots in fake-data mode with no credentials.
 * Connector config is *validated together* (URL + key) by `resolveConnectors`,
 * so a half-configured service becomes an explicit misconfiguration rather than
 * silently disappearing.
 */

const optionalUrl = z
  .string()
  .url()
  .optional()
  .or(z.literal("").transform(() => undefined));

const optionalSecret = z
  .string()
  .min(1)
  .optional()
  .or(z.literal("").transform(() => undefined));

const boolFlag = z
  .enum(["0", "1", "true", "false"])
  .optional()
  .transform((v) => v === "1" || v === "true");

/**
 * Optional bounded integer that treats a BLANK value exactly like an absent
 * one. `.env` templates ship every key with an empty value (`FOO=`), and
 * `z.coerce.number()` turns `""`/whitespace into 0 — which then fails the
 * bound check and takes the whole app down at startup while `/api/health`
 * still answers 200. Blank ⇒ undefined; anything non-blank must be a valid
 * integer in range (malformed values still fail loudly).
 */
const optionalBoundedInt = (min: number, max: number) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    z.coerce.number().int().min(min).max(max).optional(),
  );

const envSchema = z.object({
  /** Master switch between deterministic fake data and live connectors. */
  HOMELAB_DATA_MODE: z.enum(["fake", "live"]).default("fake"),
  /** Deliberate browser-facing host label; never derived from DNS or interfaces. */
  HOMELAB_HOST_LABEL: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  /** Selected interface capacity in megabits/sec for truthful visual scaling. */
  HOMELAB_NETWORK_LINK_MBPS: optionalBoundedInt(100, 100_000),

  // --- Jellyfin ---
  JELLYFIN_URL: optionalUrl,
  JELLYFIN_API_KEY: optionalSecret,
  /** Exact Docker container name used for Jellyfin telemetry attribution. */
  HOMELAB_JELLYFIN_CONTAINER: z
    .string()
    .trim()
    .min(1)
    .optional()
    .or(z.literal("").transform(() => undefined)),

  // --- Sonarr ---
  SONARR_URL: optionalUrl,
  SONARR_API_KEY: optionalSecret,

  // --- Radarr ---
  RADARR_URL: optionalUrl,
  RADARR_API_KEY: optionalSecret,

  // --- qBittorrent ---
  QBITTORRENT_URL: optionalUrl,
  QBITTORRENT_USERNAME: optionalSecret,
  QBITTORRENT_PASSWORD: optionalSecret,

  // --- Seerr / Jellyseerr (interactive media search + requests, PLA-256) ---
  SEERR_URL: optionalUrl,
  SEERR_API_KEY: optionalSecret,
  /**
   * Legacy aliases for operators still on a compatible Jellyseerr instance.
   * `SEERR_*` wins when both are set; normalized to Seerr naming internally.
   */
  JELLYSEERR_URL: optionalUrl,
  JELLYSEERR_API_KEY: optionalSecret,
  /** Disable the request action while keeping search (defaults to enabled). */
  SEERR_REQUESTS_ENABLED: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((v) => v !== "0" && v !== "false"),

  // --- ZFS collector ---
  // URL of a narrow, read-only host-side collector (see PLA-184). The dashboard
  // never shells out to `zpool` directly from browser-originated input.
  ZFS_COLLECTOR_URL: optionalUrl,
  ZFS_COLLECTOR_TOKEN: optionalSecret,
  /** Opt into direct fixed-argv `zpool`/`zfs` execution on the ZFS host. */
  HOMELAB_ZFS_COMMAND: boolFlag,

  // --- Host telemetry collector (PLA-265) ---
  // The `/v1/host` endpoint of the collector sidecar (usually the same process
  // as the ZFS collector). Token defaults to ZFS_COLLECTOR_TOKEN when unset.
  HOST_COLLECTOR_URL: optionalUrl,
  HOST_COLLECTOR_TOKEN: optionalSecret,

  // --- Operational / non-secret runtime config (previously read ad hoc) ---
  /** SQLite database file path. */
  HOMELAB_DB_PATH: z.string().min(1).default("./data/homelab.db"),
  /** Default fake scenario id (validated against the scenario list at call site). */
  HOMELAB_FAKE_SCENARIO: z.string().optional(),
  /** Force the dev scenario switcher on in a production build (screenshots/e2e). */
  HOMELAB_ENABLE_DEV_CONTROLS: boolFlag,
  /**
   * Browser-facing quick links as JSON: `[{"label":"Jellyfin","href":"https://..."}]`.
   * These are *browser-reachable* URLs, deliberately separate from the
   * server-side connector base URLs (PLA-191). Invalid JSON is ignored.
   */
  HOMELAB_QUICK_LINKS: z.string().optional(),
  /**
   * Name of the ZFS pool that holds the media library (e.g. "DataStore").
   * Used ONLY to attach import/playback flow endpoints to a pool the operator
   * has explicitly declared. Unset ⇒ flows target a generic "storage" endpoint
   * rather than guessing from I/O activity (PLA-275).
   */
  HOMELAB_MEDIA_POOL: z.string().optional(),
  /**
   * Name of the ZFS pool that holds the qBittorrent download/staging area.
   * Anchors downloader↔storage flows and distinguishes same-pool imports
   * (rename/hardlink — local organizing, no bulk transfer) from cross-pool
   * imports (a real copy). Unset ⇒ downloader storage flows end at the
   * generic "storage" endpoint; identity is never inferred from I/O.
   */
  HOMELAB_DOWNLOAD_POOL: z.string().optional(),
});

export type ServerEnv = z.infer<typeof envSchema>;

let cached: ServerEnv | null = null;

/** Parse and cache `process.env`. Throws with a readable message on misconfig. */
export function getServerEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}

/** Test/hot-reload helper: drop the cached parse so a new env is re-read. */
export function resetServerEnvCache(): void {
  cached = null;
}

/** Resolve the effective data mode. Defaults to fake for safety. */
export function getDataMode(): ServerEnv["HOMELAB_DATA_MODE"] {
  return getServerEnv().HOMELAB_DATA_MODE;
}

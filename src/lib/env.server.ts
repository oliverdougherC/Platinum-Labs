import "server-only";

import { z } from "zod";

/**
 * Server-only environment parsing.
 *
 * The `server-only` import above makes this module a build error if it is ever
 * pulled into a client component graph — enforcing the spec's hard boundary:
 * "Never expose service API keys ... to the browser."
 *
 * Secrets are optional so the app boots in fake-data mode with no credentials.
 * Real connectors (Milestone 02) read the validated values from here.
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

const envSchema = z.object({
  /** Master switch between deterministic fake data and live connectors. */
  HOMELAB_DATA_MODE: z.enum(["fake", "live"]).default("fake"),

  // --- Jellyfin ---
  JELLYFIN_URL: optionalUrl,
  JELLYFIN_API_KEY: optionalSecret,

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

  // --- ZFS collector ---
  // URL of a narrow, read-only host-side collector (see PLA-184). The dashboard
  // never shells out to `zpool` directly from browser-originated input.
  ZFS_COLLECTOR_URL: optionalUrl,
  ZFS_COLLECTOR_TOKEN: optionalSecret,
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

/** Resolve the effective data mode. Defaults to fake for safety. */
export function getDataMode(): ServerEnv["HOMELAB_DATA_MODE"] {
  return getServerEnv().HOMELAB_DATA_MODE;
}

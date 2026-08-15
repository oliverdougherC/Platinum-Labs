import "server-only";

import type { ServerEnv } from "@/lib/env.server";
import type { ConnectorId } from "@/lib/types";

/**
 * Typed connector configuration resolution (PLA-193 / Phase 1.6).
 *
 * Each connector's fields are validated *together* so a half-configured service
 * (URL without API key, qB URL without credentials, a ZFS token with no URL)
 * becomes an explicit `partial` misconfiguration rather than silently collapsing
 * into "not configured". The three states are mutually exclusive:
 *
 *   - `absent`     — no related fields set at all → intentionally unconfigured.
 *   - `configured` — all required fields present and valid.
 *   - `partial`    — some but not all required fields set → misconfiguration.
 *
 * Error strings name the *missing field(s)* only and never echo a secret value.
 */

export type ConnectorConfig<T> =
  | { kind: "configured"; value: T }
  | { kind: "absent" }
  | { kind: "partial"; error: string };

export interface HttpServiceConfig {
  url: string;
  apiKey: string;
}
export interface QbConfig {
  url: string;
  username: string;
  password: string;
}
export type ZfsConfig =
  | { mode: "helper"; url: string; token: string | undefined }
  | { mode: "command" };

export interface HostConfig {
  url: string;
  token: string | undefined;
}

export interface ResolvedConnectors {
  jellyfin: ConnectorConfig<HttpServiceConfig>;
  sonarr: ConnectorConfig<HttpServiceConfig>;
  radarr: ConnectorConfig<HttpServiceConfig>;
  qbittorrent: ConnectorConfig<QbConfig>;
  zfs: ConnectorConfig<ZfsConfig>;
  host: ConnectorConfig<HostConfig>;
}

/** Classify a fixed set of required, named fields. */
function classify<T>(
  fields: Array<{ name: string; value: string | undefined }>,
  build: () => T,
): ConnectorConfig<T> {
  const present = fields.filter((f) => f.value !== undefined);
  if (present.length === 0) return { kind: "absent" };
  if (present.length === fields.length) return { kind: "configured", value: build() };
  const missing = fields.filter((f) => f.value === undefined).map((f) => f.name);
  return {
    kind: "partial",
    error: `incomplete configuration — missing ${missing.join(", ")}`,
  };
}

function httpService(
  url: string | undefined,
  urlName: string,
  apiKey: string | undefined,
  keyName: string,
): ConnectorConfig<HttpServiceConfig> {
  return classify<HttpServiceConfig>(
    [
      { name: urlName, value: url },
      { name: keyName, value: apiKey },
    ],
    () => ({ url: url!, apiKey: apiKey! }),
  );
}

function resolveZfs(env: ServerEnv): ConnectorConfig<ZfsConfig> {
  const helper = classify<ZfsConfig>(
    [
      { name: "ZFS_COLLECTOR_URL", value: env.ZFS_COLLECTOR_URL },
      { name: "ZFS_COLLECTOR_TOKEN", value: env.ZFS_COLLECTOR_TOKEN },
    ],
    () => ({ mode: "helper", url: env.ZFS_COLLECTOR_URL!, token: env.ZFS_COLLECTOR_TOKEN! }),
  );

  // Helper mode is preferred when fully configured, and a half-configured
  // helper is always a misconfiguration rather than silently falling back to
  // direct host commands.
  if (helper.kind !== "absent") return helper;
  if (env.HOMELAB_ZFS_COMMAND) return { kind: "configured", value: { mode: "command" } };
  return helper;
}

export function resolveConnectors(env: ServerEnv): ResolvedConnectors {
  return {
    jellyfin: httpService(env.JELLYFIN_URL, "JELLYFIN_URL", env.JELLYFIN_API_KEY, "JELLYFIN_API_KEY"),
    sonarr: httpService(env.SONARR_URL, "SONARR_URL", env.SONARR_API_KEY, "SONARR_API_KEY"),
    radarr: httpService(env.RADARR_URL, "RADARR_URL", env.RADARR_API_KEY, "RADARR_API_KEY"),
    qbittorrent: classify<QbConfig>(
      [
        { name: "QBITTORRENT_URL", value: env.QBITTORRENT_URL },
        { name: "QBITTORRENT_USERNAME", value: env.QBITTORRENT_USERNAME },
        { name: "QBITTORRENT_PASSWORD", value: env.QBITTORRENT_PASSWORD },
      ],
      () => ({
        url: env.QBITTORRENT_URL!,
        username: env.QBITTORRENT_USERNAME!,
        password: env.QBITTORRENT_PASSWORD!,
      }),
    ),
    zfs: resolveZfs(env),
    host: resolveHost(env),
  };
}

/**
 * Host telemetry collector (PLA-265). Reuses the ZFS collector token when no
 * dedicated one is set — the sidecar serves both endpoints behind one token.
 */
function resolveHost(env: ServerEnv): ConnectorConfig<HostConfig> {
  const token = env.HOST_COLLECTOR_TOKEN ?? env.ZFS_COLLECTOR_TOKEN;
  return classify<HostConfig>(
    [
      { name: "HOST_COLLECTOR_URL", value: env.HOST_COLLECTOR_URL },
      { name: "HOST_COLLECTOR_TOKEN (or ZFS_COLLECTOR_TOKEN)", value: token },
    ],
    () => ({ url: env.HOST_COLLECTOR_URL!, token }),
  );
}

export const CORE_CONNECTOR_IDS: ConnectorId[] = [
  "jellyfin",
  "sonarr",
  "radarr",
  "qbittorrent",
  "zfs",
  "host",
];

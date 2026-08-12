/**
 * Non-secret, typed application configuration.
 *
 * Everything here is safe to ship to the browser: display names, poll cadence,
 * thresholds, and quick links. Service URLs and API keys live only in
 * `env.server.ts` behind a `server-only` guard.
 */

import type { ConnectorId } from "@/lib/types";

export interface QuickLink {
  label: string;
  /** Public/browser-reachable URL for the launch tile. */
  href: string;
}

export interface ThresholdConfig {
  /** Pool capacity fraction that raises a warning. */
  storageWarnFraction: number;
  /** Pool capacity fraction that raises a critical alert. */
  storageCriticalFraction: number;
  /** A transfer stalled longer than this (seconds) is flagged. */
  stalledTransferSeconds: number;
  /** Connector unreachable longer than this (ms) before it is "unavailable". */
  connectorGraceMs: number;
}

export interface AppConfig {
  appName: string;
  /** Per-connector poll cadence, mirrored server-side by the scheduler. */
  pollIntervalsMs: Record<ConnectorId, number>;
  thresholds: ThresholdConfig;
  quickLinks: QuickLink[];
}

export const appConfig: AppConfig = {
  appName: "Homelab",
  pollIntervalsMs: {
    jellyfin: 12_000,
    sonarr: 25_000,
    radarr: 25_000,
    qbittorrent: 10_000,
    zfs: 60_000,
  },
  thresholds: {
    storageWarnFraction: 0.8,
    storageCriticalFraction: 0.9,
    stalledTransferSeconds: 15 * 60,
    connectorGraceMs: 90_000,
  },
  // Placeholder quick links; real hosts come from user config in PLA-191.
  quickLinks: [
    { label: "Jellyfin", href: "http://localhost:8096" },
    { label: "Sonarr", href: "http://localhost:8989" },
    { label: "Radarr", href: "http://localhost:7878" },
    { label: "qBittorrent", href: "http://localhost:8080" },
  ],
};

/**
 * Notification center (PLA-268) — pure grouping/filtering, no React, tested.
 *
 * The attention engine (server) owns detection, hysteresis, and stable
 * per-instance identity (`alertId`). This module owns the CLIENT view:
 * grouping related alerts, applying dismiss/snooze/mute preferences, and
 * ranking severity — without ever mutating engine state.
 */

import type { AttentionItem, Severity } from "@/lib/types";

export interface NotificationPrefs {
  /** alertId → epoch ms it was dismissed. A NEWER occurrence (firstSeenAt >
   * dismissedAt) becomes visible again; re-firing of the same occurrence stays
   * hidden. */
  dismissed: Record<string, number>;
  /** alertId → epoch ms until which it is snoozed. */
  snoozed: Record<string, number>;
  /** Muted rule classes (e.g. "qbittorrent.transfer.stalled"). */
  mutedRules: string[];
  /** Muted sources (e.g. "radarr"). */
  mutedSources: string[];
}

export function emptyPrefs(): NotificationPrefs {
  return { dismissed: {}, snoozed: {}, mutedRules: [], mutedSources: [] };
}

export type NotificationVisibility = "visible" | "dismissed" | "snoozed" | "muted";

export function itemVisibility(
  item: AttentionItem,
  prefs: NotificationPrefs,
  now: number,
): NotificationVisibility {
  if (
    prefs.mutedRules.includes(item.ruleId) ||
    prefs.mutedSources.includes(item.source)
  ) {
    return "muted";
  }
  const snoozedUntil = prefs.snoozed[item.alertId];
  if (snoozedUntil !== undefined && now < snoozedUntil) return "snoozed";
  const dismissedAt = prefs.dismissed[item.alertId];
  if (dismissedAt !== undefined && item.firstSeenAt <= dismissedAt) {
    return "dismissed";
  }
  return "visible";
}

export interface NotificationGroup {
  /** Stable group key: `source:ruleId`. */
  key: string;
  source: AttentionItem["source"];
  ruleId: string;
  severity: Severity;
  /** e.g. "Radarr · 2 stalled downloads" (single item keeps its own title). */
  title: string;
  items: AttentionItem[];
  firstSeenAt: number;
  lastSeenAt: number;
}

const SEVERITY_ORDER: Severity[] = ["critical", "warning", "info"];

function severityRank(s: Severity): number {
  const i = SEVERITY_ORDER.indexOf(s);
  return i === -1 ? SEVERITY_ORDER.length : i;
}

const SOURCE_LABEL: Record<string, string> = {
  jellyfin: "Jellyfin",
  sonarr: "Sonarr",
  radarr: "Radarr",
  qbittorrent: "qBittorrent",
  zfs: "Storage",
  host: "Host",
  seerr: "Requests",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source;
}

/** Short plural noun for a rule class, used in grouped titles. */
function ruleNoun(ruleId: string, count: number): string {
  const plural = count !== 1;
  if (ruleId.includes("stalled")) return plural ? "stalled downloads" : "stalled download";
  if (ruleId.includes("transfer")) return plural ? "failed transfers" : "failed transfer";
  if (ruleId.includes("capacity")) return plural ? "capacity warnings" : "capacity warning";
  if (ruleId.includes("pool")) return plural ? "pool issues" : "pool issue";
  if (ruleId.includes("scrub")) return plural ? "scrub issues" : "scrub issue";
  if (ruleId.includes("unavailable")) return plural ? "services unreachable" : "service unreachable";
  return plural ? "alerts" : "alert";
}

/**
 * Group visible attention items by (source, ruleId). Groups are ordered most
 * severe first, then most recent. `hidden` counts how many items preferences
 * removed (for a subtle "N muted" affordance).
 */
export function groupNotifications(
  items: AttentionItem[],
  prefs: NotificationPrefs,
  now: number,
): { groups: NotificationGroup[]; hiddenCount: number } {
  const visible: AttentionItem[] = [];
  let hiddenCount = 0;
  for (const item of items) {
    if (itemVisibility(item, prefs, now) === "visible") visible.push(item);
    else hiddenCount += 1;
  }

  const byKey = new Map<string, AttentionItem[]>();
  for (const item of visible) {
    const key = `${item.source}:${item.ruleId}`;
    const group = byKey.get(key) ?? [];
    group.push(item);
    byKey.set(key, group);
  }

  const groups: NotificationGroup[] = [];
  for (const [key, groupItems] of byKey) {
    const first = groupItems[0]!;
    const severity = groupItems
      .map((i) => i.severity)
      .sort((a, b) => severityRank(a) - severityRank(b))[0]!;
    const title =
      groupItems.length === 1
        ? first.title
        : `${sourceLabel(first.source)} · ${groupItems.length} ${ruleNoun(first.ruleId, groupItems.length)}`;
    groups.push({
      key,
      source: first.source,
      ruleId: first.ruleId,
      severity,
      title,
      items: [...groupItems].sort((a, b) => b.lastSeenAt - a.lastSeenAt),
      firstSeenAt: Math.min(...groupItems.map((i) => i.firstSeenAt)),
      lastSeenAt: Math.max(...groupItems.map((i) => i.lastSeenAt)),
    });
  }

  groups.sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      b.lastSeenAt - a.lastSeenAt ||
      a.key.localeCompare(b.key),
  );
  return { groups, hiddenCount };
}

/** True when any ACTIVE (pref-filtered) alert is critical — drives the edge indicator. */
export function hasCritical(
  items: AttentionItem[],
  prefs: NotificationPrefs,
  now: number,
): boolean {
  return items.some(
    (i) => i.severity === "critical" && itemVisibility(i, prefs, now) === "visible",
  );
}

// --- pref transitions (pure) -------------------------------------------------

export function dismissAlert(
  prefs: NotificationPrefs,
  alertId: string,
  now: number,
): NotificationPrefs {
  return { ...prefs, dismissed: { ...prefs.dismissed, [alertId]: now } };
}

export function dismissGroup(
  prefs: NotificationPrefs,
  group: NotificationGroup,
  now: number,
): NotificationPrefs {
  const dismissed = { ...prefs.dismissed };
  for (const item of group.items) dismissed[item.alertId] = now;
  return { ...prefs, dismissed };
}

export function snoozeGroup(
  prefs: NotificationPrefs,
  group: NotificationGroup,
  untilMs: number,
): NotificationPrefs {
  const snoozed = { ...prefs.snoozed };
  for (const item of group.items) snoozed[item.alertId] = untilMs;
  return { ...prefs, snoozed };
}

export function toggleMuteRule(prefs: NotificationPrefs, ruleId: string): NotificationPrefs {
  const muted = prefs.mutedRules.includes(ruleId)
    ? prefs.mutedRules.filter((r) => r !== ruleId)
    : [...prefs.mutedRules, ruleId];
  return { ...prefs, mutedRules: muted };
}

export function toggleMuteSource(
  prefs: NotificationPrefs,
  source: string,
): NotificationPrefs {
  const muted = prefs.mutedSources.includes(source)
    ? prefs.mutedSources.filter((s) => s !== source)
    : [...prefs.mutedSources, source];
  return { ...prefs, mutedSources: muted };
}

/**
 * Bound stored state: drop dismiss/snooze entries older than `maxAgeMs`
 * (default 30 days) so the persisted map cannot grow forever.
 */
export function prunePrefs(
  prefs: NotificationPrefs,
  now: number,
  maxAgeMs = 30 * 24 * 60 * 60_000,
): NotificationPrefs {
  const dismissed: Record<string, number> = {};
  for (const [id, at] of Object.entries(prefs.dismissed)) {
    if (now - at < maxAgeMs) dismissed[id] = at;
  }
  const snoozed: Record<string, number> = {};
  for (const [id, until] of Object.entries(prefs.snoozed)) {
    if (until > now) snoozed[id] = until;
  }
  return { ...prefs, dismissed, snoozed };
}

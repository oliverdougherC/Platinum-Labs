/**
 * Notification preference persistence (PLA-268) — localStorage-backed,
 * injectable for tests, versioned, and failure-tolerant: a broken/blocked
 * storage never breaks the notification center.
 */

import {
  emptyPrefs,
  prunePrefs,
  type NotificationPrefs,
} from "@/lib/notifications/center";

export const PREFS_STORAGE_KEY = "homelab.notifications.v1";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isNumberRecord(v: unknown): v is Record<string, number> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v).every((x) => typeof x === "number" && Number.isFinite(x))
  );
}

/** Parse + validate stored prefs; anything malformed collapses to empty. */
export function parsePrefs(raw: string | null): NotificationPrefs {
  if (!raw) return emptyPrefs();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return emptyPrefs();
    const p = parsed as Record<string, unknown>;
    return {
      dismissed: isNumberRecord(p.dismissed) ? p.dismissed : {},
      snoozed: isNumberRecord(p.snoozed) ? p.snoozed : {},
      mutedRules: isStringArray(p.mutedRules) ? p.mutedRules : [],
      mutedSources: isStringArray(p.mutedSources) ? p.mutedSources : [],
    };
  } catch {
    return emptyPrefs();
  }
}

export function loadPrefs(
  now: number,
  storage: StorageLike | null = defaultStorage(),
): NotificationPrefs {
  if (!storage) return emptyPrefs();
  try {
    return prunePrefs(parsePrefs(storage.getItem(PREFS_STORAGE_KEY)), now);
  } catch {
    return emptyPrefs();
  }
}

export function savePrefs(
  prefs: NotificationPrefs,
  now: number,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prunePrefs(prefs, now)));
  } catch {
    // Quota/blocked storage: prefs stay in-memory for the session.
  }
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Cross-service activity event pipeline (PLA-185).
 *
 * `deriveEvents(prev, curr)` diffs two consecutive normalized snapshots and
 * emits only *meaningful transitions* — never poll heartbeats. It is pure and
 * deterministic: the same (prev, curr) pair always yields identical events with
 * identical ids, so persisting with `INSERT OR IGNORE` naturally dedupes even
 * when polling windows overlap.
 *
 * The first snapshot (prev = null) is treated as a baseline and emits nothing,
 * so a dashboard boot never spams "started" events for already-in-progress
 * activity.
 */

import type {
  AcquisitionItem,
  ActivityEvent,
  ConnectorHealth,
  DashboardSnapshot,
  EventKind,
  JellyfinSession,
  Severity,
  ZfsPool,
} from "@/lib/types";

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((i) => [i.id, i]));
}

export function deriveEvents(
  prev: DashboardSnapshot | null,
  curr: DashboardSnapshot,
): ActivityEvent[] {
  if (!prev) return []; // baseline snapshot: nothing to diff against

  const at = curr.generatedAt;
  const events: ActivityEvent[] = [];
  const emit = (
    kind: EventKind,
    severity: Severity,
    source: ActivityEvent["source"],
    subject: string,
    message: string,
  ): void => {
    events.push({ id: `${kind}:${subject}:${at}`, at, kind, severity, source, message, subject });
  };

  derivePlayback(prev.jellyfin.sessions, curr.jellyfin.sessions, emit);
  deriveAcquisition(prev.acquisition.items, curr.acquisition.items, emit);
  deriveZfs(prev.zfs.pools, curr.zfs.pools, emit);
  deriveHealth(prev.health, curr.health, emit);

  return events;
}

type Emit = (
  kind: EventKind,
  severity: Severity,
  source: ActivityEvent["source"],
  subject: string,
  message: string,
) => void;

function derivePlayback(
  prev: JellyfinSession[],
  curr: JellyfinSession[],
  emit: Emit,
): void {
  const before = byId(prev);
  const after = byId(curr);
  for (const [id, s] of after) {
    if (!before.has(id)) {
      emit("playback.started", "info", "jellyfin", id, `${s.user} started watching ${s.title}`);
    }
  }
  for (const [id, s] of before) {
    if (!after.has(id)) {
      emit("playback.stopped", "info", "jellyfin", id, `${s.user} stopped watching ${s.title}`);
    }
  }
}

function deriveAcquisition(
  prev: AcquisitionItem[],
  curr: AcquisitionItem[],
  emit: Emit,
): void {
  const before = byId(prev);
  const after = byId(curr);

  for (const [id, item] of after) {
    const p = before.get(id);
    if (!p) {
      // A newly-seen item: announce it by the state it first appears in.
      if (item.state === "downloading") {
        emit("download.started", "info", item.source, id, `Downloading ${item.title}`);
      } else if (item.state === "stalled") {
        emit("transfer.stalled", "warning", item.source, id, `Transfer stalled: ${item.title}`);
      } else if (item.state === "failed") {
        emit("transfer.failed", "warning", item.source, id, `Transfer failed: ${item.title}`);
      }
      continue;
    }
    if (p.state === item.state) continue;

    switch (item.state) {
      case "failed":
        emit("transfer.failed", "warning", item.source, id, `Transfer failed: ${item.title}`);
        break;
      case "stalled":
        emit("transfer.stalled", "warning", item.source, id, `Transfer stalled: ${item.title}`);
        break;
      case "completed":
        emit("transfer.completed", "info", item.source, id, `Completed ${item.title}`);
        break;
      case "downloading":
        if (p.state === "stalled" || p.state === "failed") {
          emit("transfer.recovered", "info", item.source, id, `Recovered ${item.title}`);
        }
        break;
      default:
        break;
    }
  }

  // Items that left the queue after importing / near-completion → imported.
  for (const [id, p] of before) {
    if (after.has(id)) continue;
    if (p.state === "importing" || (p.state === "downloading" && p.progress >= 0.99)) {
      emit("media.imported", "info", p.source, id, `Imported ${p.title}`);
    }
  }
}

function deriveZfs(prev: ZfsPool[], curr: ZfsPool[], emit: Emit): void {
  const before = new Map(prev.map((p) => [p.name, p]));
  for (const pool of curr) {
    const p = before.get(pool.name);
    if (!p) continue;

    if (p.health !== pool.health) {
      const severity: Severity = pool.health === "ONLINE" ? "info" : "critical";
      emit("pool.health.changed", severity, "zfs", pool.name, `Pool ${pool.name} is now ${pool.health}`);
    }

    if (pool.lastScrubAt && pool.lastScrubAt !== p.lastScrubAt) {
      if (pool.scrubErrors > 0) {
        emit("zfs.scrub.failed", "warning", "zfs", pool.name, `Scrub of ${pool.name} finished with ${pool.scrubErrors} errors`);
      } else {
        emit("zfs.scrub.completed", "info", "zfs", pool.name, `Scrub of ${pool.name} completed with 0 errors`);
      }
    }
  }
}

function deriveHealth(
  prev: ConnectorHealth[],
  curr: ConnectorHealth[],
  emit: Emit,
): void {
  const before = new Map(prev.map((h) => [h.id, h]));
  for (const h of curr) {
    const p = before.get(h.id);
    if (!p || p.status === h.status) continue;
    if (h.status === "healthy" && p.status !== "healthy") {
      emit("connector.recovered", "info", h.id, h.id, `${h.id} recovered`);
    } else if (h.status !== "healthy" && p.status === "healthy") {
      emit("connector.lost", "warning", h.id, h.id, `${h.id} is ${h.status}`);
    }
  }
}

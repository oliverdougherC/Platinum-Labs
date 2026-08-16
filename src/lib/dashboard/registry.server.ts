import "server-only";

import { getServerEnv } from "@/lib/env.server";
import { appConfig } from "@/lib/config";
import { fetchJson } from "@/lib/connectors/http";
import { ConnectorRuntime } from "@/lib/connectors/runtime";
import { ConnectorHub } from "@/lib/connectors/hub";
import { PollScheduler } from "@/lib/connectors/scheduler";
import {
  resolveConnectors,
  CORE_CONNECTOR_IDS,
  type ResolvedConnectors,
} from "@/lib/connectors/config.server";
import { createJellyfinConnector, type HttpGet } from "@/lib/connectors/jellyfin";
import { createSonarrConnector, createRadarrConnector } from "@/lib/connectors/servarr";
import { createQbittorrentConnector } from "@/lib/connectors/qbittorrent";
import { makeQbClient } from "@/lib/connectors/qbittorrent.server";
import { createZfsConnector } from "@/lib/connectors/zfs";
import { makeCommandCollect, makeHelperCollect } from "@/lib/connectors/zfs.server";
import { createHostConnector, makeHostCollect } from "@/lib/telemetry/host.server";
import {
  emptyTelemetryHistory,
  pushBounded,
} from "@/lib/telemetry/history";
import {
  emptyTelemetry,
  gradeTelemetryFreshness,
  notConfiguredTelemetry,
} from "@/lib/telemetry/normalize";
import {
  assembleSnapshot,
  fillConnectorHealth,
  filterAcquisitionForDisplay,
  type ConnectorConfigStatus,
} from "@/lib/dashboard/aggregate";
import { getDb, tryPersist } from "@/lib/db/db.server";
import {
  insertActivityEvent,
  insertStorageSample,
  insertThroughput,
  lastPlaybackAt,
  recentEvents,
  recentThroughput,
  recordHealthTransition,
  resolveAlert,
  storageTrend,
  upsertAlert,
} from "@/lib/db/repository";
import { runMaintenance } from "@/lib/db/retention";
import { deriveEvents } from "@/lib/pipeline/events";
import { evaluate, type AlertState, type EvaluateResult } from "@/lib/attention/engine";
import { detectConditions, ruleTimings, RULE } from "@/lib/attention/rules";
import type { ActivityEvent, ConnectorId } from "@/lib/types";
import type {
  AcquisitionSnapshot,
  DashboardHistory,
  DashboardSnapshot,
  HostTelemetrySnapshot,
  JellyfinSnapshot,
  ServarrSnapshot,
  TelemetryHistory,
  ZfsSnapshot,
} from "@/lib/types";

/**
 * Live registry (PLA-186) — `server-only`.
 *
 * Builds connectors from validated env, runs them on the shared scheduler
 * (upstream cadence), and — on a SEPARATE, slower loop — assembles the cached
 * aggregate snapshot, samples history, derives+persists events, and records
 * health transitions. The API reads only the cached snapshot, so browser
 * refreshes never trigger upstream polls (no N+1) and one failing connector
 * yields a partial snapshot rather than an error.
 *
 * Startup establishes a silent event baseline: connectors perform one isolated
 * initial refresh, the first assembled aggregate becomes `prevForEvents`, and
 * only *subsequent* transitions are turned into activity events — so a boot never
 * emits false "started"/"recovered"/"pool-health-changed" events (Phase 1.2).
 */

const httpGet: HttpGet = (url, opts) => fetchJson(url, opts);

const ASSEMBLE_INTERVAL_MS = 5_000;
const MAINTENANCE_INTERVAL_MS = 60 * 60_000; // hourly
const ACTIVITY_LIMIT = 50;
/** Minimum spacing between persisted storage samples (throttles the 60s poll). */
const STORAGE_SAMPLE_MIN_MS = 15 * 60_000;

interface LiveRegistry {
  hub: ConnectorHub;
  scheduler: PollScheduler;
  configStatus: Record<ConnectorId, ConnectorConfigStatus>;
  jellyfinRt: ConnectorRuntime<JellyfinSnapshot> | null;
  sonarrRt: ConnectorRuntime<ServarrSnapshot> | null;
  radarrRt: ConnectorRuntime<ServarrSnapshot> | null;
  qbRt: ConnectorRuntime<AcquisitionSnapshot> | null;
  zfsRt: ConnectorRuntime<ZfsSnapshot> | null;
  hostRt: ConnectorRuntime<HostTelemetrySnapshot> | null;
}

let registry: LiveRegistry | null = null;
let cached: DashboardSnapshot | null = null;
let prevForEvents: DashboardSnapshot | null = null;
let alertStates = new Map<string, AlertState>();
let initPromise: Promise<void> | null = null;
let assembleTimer: ReturnType<typeof setInterval> | null = null;
let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
let telemetryTimer: ReturnType<typeof setInterval> | null = null;

/** Engine rules whose lifecycle deriveEvents does NOT already cover. */
const ENGINE_EVENT_RULES = new Set<string>([RULE.capacityWarning, RULE.capacityCritical]);

// Storage-sampling cadence state: only persist a storage row when a *new* ZFS
// observation arrives (its lastSuccessAt advances) and enough time has elapsed —
// never once per 5s aggregate cycle (Phase 1.1 / PLA-179).
let lastStorageSampleAt = 0;
let lastZfsObservedAt: number | null = null;

/** Turn the resolved config into the status map used to fill absent connectors. */
function buildConfigStatus(
  resolved: ResolvedConnectors,
): Record<ConnectorId, ConnectorConfigStatus> {
  const out = {} as Record<ConnectorId, ConnectorConfigStatus>;
  for (const id of CORE_CONNECTOR_IDS) {
    const c = resolved[id];
    out[id] = {
      configured: c.kind === "configured",
      configError: c.kind === "partial" ? c.error : null,
      pollIntervalMs: appConfig.pollIntervalsMs[id],
    };
    if (c.kind === "partial") {
      // Sanitized (names missing fields only, never a secret value).
      console.warn(`[config] ${id}: ${c.error}`);
    }
  }
  return out;
}

function build(): LiveRegistry {
  const env = getServerEnv();
  const resolved = resolveConnectors(env);
  const hub = new ConnectorHub();
  const runtimes: ConnectorRuntime<unknown>[] = [];
  const p = appConfig.pollIntervalsMs;

  const jellyfinRt =
    resolved.jellyfin.kind === "configured"
      ? new ConnectorRuntime(
          createJellyfinConnector(
            { ...resolved.jellyfin.value, pollIntervalMs: p.jellyfin },
            httpGet,
          ),
        )
      : null;

  const sonarrRt =
    resolved.sonarr.kind === "configured"
      ? new ConnectorRuntime(
          createSonarrConnector(
            { ...resolved.sonarr.value, pollIntervalMs: p.sonarr },
            httpGet,
          ),
        )
      : null;

  const radarrRt =
    resolved.radarr.kind === "configured"
      ? new ConnectorRuntime(
          createRadarrConnector(
            { ...resolved.radarr.value, pollIntervalMs: p.radarr },
            httpGet,
          ),
        )
      : null;

  const qbRt =
    resolved.qbittorrent.kind === "configured"
      ? new ConnectorRuntime(
          createQbittorrentConnector(
            { pollIntervalMs: p.qbittorrent },
            makeQbClient(resolved.qbittorrent.value),
          ),
        )
      : null;

  const zfsRt =
    resolved.zfs.kind === "configured"
      ? new ConnectorRuntime(
          createZfsConnector(
            { pollIntervalMs: p.zfs },
            resolved.zfs.value.mode === "helper"
              ? makeHelperCollect(resolved.zfs.value.url, resolved.zfs.value.token)
              : makeCommandCollect(),
          ),
        )
      : null;

  const hostRt =
    resolved.host.kind === "configured"
      ? new ConnectorRuntime(
          createHostConnector(
            { pollIntervalMs: p.host },
            makeHostCollect(resolved.host.value.url, resolved.host.value.token),
          ),
        )
      : null;

  for (const rt of [jellyfinRt, sonarrRt, radarrRt, qbRt, zfsRt, hostRt]) {
    if (rt) {
      hub.register(rt as ConnectorRuntime<unknown>);
      runtimes.push(rt as ConnectorRuntime<unknown>);
    }
  }

  return {
    hub,
    scheduler: new PollScheduler(hub, runtimes),
    configStatus: buildConfigStatus(resolved),
    jellyfinRt,
    sonarrRt,
    radarrRt,
    qbRt,
    zfsRt,
    hostRt,
  };
}

// Bounded telemetry history, sampled on its own 2s tick (matches host cadence).
const TELEMETRY_TICK_MS = 2_000;
/** A telemetry sample older than this is re-graded `stale` (kept, labeled). */
const TELEMETRY_STALE_MS = 10_000;
let telemetryHistory: TelemetryHistory = emptyTelemetryHistory();
let lastTelemetrySampleAt: number | null = null;

function sampleTelemetryHistory(reg: LiveRegistry, now: number): void {
  const snap = reg.hostRt?.getState().snapshot ?? null;
  if (!snap) return;
  // Only append when the collector actually produced a new sample; a stalled
  // collector must not flat-line the sparklines with repeats.
  const at = snap.cpu.updatedAt ?? snap.network.updatedAt;
  if (at === null || at === lastTelemetrySampleAt) return;
  lastTelemetrySampleAt = at;
  if (snap.cpu.status === "available" && snap.cpu.value) {
    pushBounded(telemetryHistory.cpuTotal, { t: now, v: snap.cpu.value.totalFraction });
  }
  if (snap.network.status === "available" && snap.network.value) {
    pushBounded(telemetryHistory.netRx, { t: now, v: snap.network.value.rxBps });
    pushBounded(telemetryHistory.netTx, { t: now, v: snap.network.value.txBps });
  }
  if (snap.disk.status === "available" && snap.disk.value) {
    pushBounded(telemetryHistory.diskRead, { t: now, v: snap.disk.value.readBps });
    pushBounded(telemetryHistory.diskWrite, { t: now, v: snap.disk.value.writeBps });
  }
}

/** Current graded telemetry + bounded history (used by assemble and the SSE stream). */
function currentTelemetry(reg: LiveRegistry, now: number): {
  telemetry: HostTelemetrySnapshot;
  history: TelemetryHistory;
} {
  const raw = reg.hostRt?.getState().snapshot ?? null;
  const telemetry = raw
    ? gradeTelemetryFreshness(raw, now, TELEMETRY_STALE_MS)
    : reg.configStatus.host?.configured
      ? emptyTelemetry()
      : notConfiguredTelemetry();
  return { telemetry, history: telemetryHistory };
}

function assemble(reg: LiveRegistry, now: number): DashboardSnapshot {
  const health = fillConnectorHealth(reg.hub.health(), reg.configStatus);
  const { telemetry, history: telemetryHist } = currentTelemetry(reg, now);
  const snapshot = assembleSnapshot({
    now,
    health,
    jellyfin: reg.jellyfinRt?.getState().snapshot ?? null,
    sonarr: reg.sonarrRt?.getState().snapshot?.items ?? null,
    radarr: reg.radarrRt?.getState().snapshot?.items ?? null,
    qbittorrent: reg.qbRt?.getState().snapshot ?? null,
    zfs: reg.zfsRt?.getState().snapshot ?? null,
    telemetry,
    telemetryNotConfigured: !reg.configStatus.host?.configured,
    telemetryHistory: telemetryHist,
    history: readHistory(now),
    mediaPool: getServerEnv().HOMELAB_MEDIA_POOL ?? null,
    downloadPool: getServerEnv().HOMELAB_DOWNLOAD_POOL ?? null,
  });

  // Jellyfin's /Sessions only reports *current* playback, so its lastPlaybackAt
  // is null once everyone stops. Backfill it from the persisted playback events
  // so the idle "Last played N ago" line is truthful rather than missing.
  const jf = snapshot.jellyfin;
  if (jf.serverAvailable && jf.sessions.length === 0 && jf.lastPlaybackAt === null) {
    try {
      const last = lastPlaybackAt(getDb());
      if (last !== null) snapshot.jellyfin = { ...jf, lastPlaybackAt: last };
    } catch {
      // A DB read failure must not affect rendering — leave it null.
    }
  }
  return snapshot;
}

function readHistory(now: number): DashboardHistory {
  try {
    const db = getDb();
    const throughput = recentThroughput(db, now, 45 * 60_000).map((s) => ({
      t: s.t,
      bps: s.bps,
    }));
    const rows = storageTrend(db, now, 30);
    const byT = new Map<number, { t: number } & Record<string, number>>();
    const series = new Set<string>();
    for (const r of rows) {
      series.add(r.pool);
      const row = byT.get(r.t) ?? { t: r.t };
      row[r.pool] = r.usedBytes;
      byT.set(r.t, row);
    }
    return {
      throughput,
      storageSeries: [...series],
      storage: [...byT.values()].sort((a, b) => a.t - b.t),
    };
  } catch {
    return { throughput: [], storageSeries: [], storage: [] };
  }
}

/**
 * Read the persisted normalized activity feed (newest first, bounded). Returns
 * an explicit availability flag so a read FAILURE (empty + available:false) is
 * never rendered as "nothing happened" (empty + available:true) — PLA-194.
 */
function readActivity(): { events: ActivityEvent[]; available: boolean } {
  try {
    return { events: recentEvents(getDb(), ACTIVITY_LIMIT), available: true };
  } catch {
    // One DB read failure must never make the dashboard fail, but it must also
    // not masquerade as a truthful empty feed.
    return { events: [], available: false };
  }
}

/**
 * Run the deterministic attention engine against the snapshot's normalized
 * domain data, update the in-memory alert states, and assign the ranked active
 * alerts onto `snapshot.attention`. Returns the engine result for persistence.
 * Never throws (rule detection is individually guarded).
 */
function applyAttention(snapshot: DashboardSnapshot, now: number): EvaluateResult {
  const result = evaluate(
    alertStates,
    detectConditions({
      health: snapshot.health,
      pools: snapshot.zfs.pools,
      acquisition: snapshot.acquisition.items,
      thresholds: appConfig.thresholds,
    }),
    ruleTimings(appConfig.thresholds),
    now,
  );
  alertStates = result.states;
  snapshot.attention = result.active;
  return result;
}

/**
 * Sonarr/Radarr recent-history events → activity feed. These are the
 * authoritative import/failure signals (from `/api/v3/history`), replacing the
 * old "queue item disappeared" inference. Ids are stable per upstream record so
 * `INSERT OR IGNORE` dedupes across overlapping windows and polls.
 */
function servarrHistoryActivity(reg: LiveRegistry): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  for (const rt of [reg.sonarrRt, reg.radarrRt]) {
    const events = rt?.getState().snapshot?.events ?? [];
    for (const ev of events) {
      out.push({
        id: ev.id,
        at: ev.at,
        kind: ev.kind,
        severity: ev.kind === "transfer.failed" ? "warning" : "info",
        source: ev.source,
        message:
          ev.kind === "media.imported"
            ? `Imported ${ev.title}`
            : `Transfer failed: ${ev.title}`,
        subject: ev.id,
      });
    }
  }
  return out;
}

/** Capacity-alert lifecycle → activity feed (idempotent ids). deriveEvents owns
 * the rest (connector/transfer/pool/scrub transitions). */
function alertActivityEvents(result: EvaluateResult): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  for (const s of result.opened) {
    if (!ENGINE_EVENT_RULES.has(s.ruleId)) continue;
    out.push({
      id: `alert.opened:${s.alertId}:${s.firstSeenAt ?? 0}`,
      at: s.firstSeenAt ?? 0,
      kind: "alert.opened",
      severity: s.severity,
      source: s.source,
      message: s.detail,
      subject: s.subject,
    });
  }
  for (const s of result.resolved) {
    if (!ENGINE_EVENT_RULES.has(s.ruleId)) continue;
    out.push({
      id: `alert.resolved:${s.alertId}:${s.resolvedAt ?? 0}`,
      at: s.resolvedAt ?? 0,
      kind: "alert.resolved",
      severity: "info",
      source: s.source,
      message: `Resolved: ${s.title}`,
      subject: s.subject,
    });
  }
  return out;
}

/**
 * Persist samples, health transitions, derived events, and alert lifecycle.
 * On the baseline (prevForEvents === null) deriveEvents is naturally empty, so
 * no false events are recorded — but current bad conditions still open alerts.
 */
function persist(
  reg: LiveRegistry,
  snapshot: DashboardSnapshot,
  now: number,
  attention: EvaluateResult,
): void {
  tryPersist((db) => {
    // Throughput sampled every cycle (feeds the ~45m media chart).
    if (snapshot.acquisition.rollup.aggregateRateBps !== null) {
      insertThroughput(db, {
        t: now,
        bps: snapshot.acquisition.rollup.aggregateRateBps,
      });
    }

    // Storage sampled only on a NEW ZFS observation, throttled to a low cadence —
    // never once per aggregate cycle.
    const zfsObservedAt = reg.zfsRt?.getState().health.lastSuccessAt ?? null;
    const isNewObservation = zfsObservedAt !== null && zfsObservedAt !== lastZfsObservedAt;
    if (
      snapshot.zfs.pools.length > 0 &&
      isNewObservation &&
      now - lastStorageSampleAt >= STORAGE_SAMPLE_MIN_MS
    ) {
      for (const pool of snapshot.zfs.pools) {
        insertStorageSample(db, {
          t: now,
          pool: pool.name,
          usedBytes: pool.usedBytes,
          totalBytes: pool.totalBytes,
        });
      }
      lastStorageSampleAt = now;
    }
    if (zfsObservedAt !== null) lastZfsObservedAt = zfsObservedAt;

    // Health transitions (deduped inside the repository).
    for (const h of snapshot.health) recordHealthTransition(db, now, h.id, h.status);

    // Derived activity events (idempotent by id; empty on the baseline) plus the
    // non-overlapping capacity-alert lifecycle events and authoritative Sonarr/
    // Radarr history events. All are idempotent by id (INSERT OR IGNORE).
    for (const ev of deriveEvents(prevForEvents, snapshot)) insertActivityEvent(db, ev);
    for (const ev of alertActivityEvents(attention)) insertActivityEvent(db, ev);
    for (const ev of servarrHistoryActivity(reg)) insertActivityEvent(db, ev);

    // Alert lifecycle rows (stable per-instance alert_id).
    for (const s of attention.states.values()) {
      if (s.status !== "active") continue;
      upsertAlert(db, {
        alertId: s.alertId,
        ruleId: s.ruleId,
        severity: s.severity,
        title: s.title,
        detail: s.detail,
        source: s.source,
        subject: s.subject ?? null,
        firstSeenAt: s.firstSeenAt ?? now,
        lastSeenAt: s.lastSeenAt,
      });
    }
    for (const s of attention.resolved) resolveAlert(db, s.alertId, s.resolvedAt ?? now);
  });
}

/** One aggregate step: assemble, evaluate attention, persist, attach activity. */
function step(reg: LiveRegistry, now: number): void {
  // The FULL snapshot (correlated, including completed transfers) drives attention
  // and event derivation so completion transitions are never lost.
  const snapshot = assemble(reg, now);
  const attention = applyAttention(snapshot, now);
  persist(reg, snapshot, now, attention);
  prevForEvents = snapshot;

  // The PUBLIC snapshot drops the seeding/completed library from the browser
  // payload and attaches the persisted feed AFTER deriving this cycle's events so
  // the newest events are included immediately.
  const activity = readActivity();
  const publicSnapshot: DashboardSnapshot = {
    ...snapshot,
    acquisition: filterAcquisitionForDisplay(snapshot.acquisition),
    activity: activity.events,
    activityAvailable: activity.available,
  };
  cached = publicSnapshot;
}

/** Non-blocking scheduled maintenance (retention + downsampling). */
function runScheduledMaintenance(): void {
  tryPersist((db) => {
    runMaintenance(db, Date.now());
  });
}

/**
 * One-time startup: isolated initial refresh → baseline aggregate → start the
 * background loops. Idempotent via `initPromise`; tolerant of unavailable
 * connectors (a failing initial refresh still yields a partial baseline).
 */
async function init(reg: LiveRegistry): Promise<void> {
  // 1. Configured connectors perform one isolated initial refresh.
  await reg.hub.refreshAll();

  // 2. First aggregate becomes the silent event baseline (prevForEvents is still
  //    null, so persist() records samples/health but emits no derived events).
  //    Current bad conditions still open alerts — that reflects real state, not a
  //    spurious "just happened" event.
  step(reg, Date.now());

  // 3. Background polling continues on each connector's own cadence (we already
  //    primed above, so skip the scheduler's immediate fan-out).
  reg.scheduler.start(false);

  // 4. Slow aggregate loop + low-cadence maintenance loop.
  assembleTimer = setInterval(() => step(reg, Date.now()), ASSEMBLE_INTERVAL_MS);
  if (assembleTimer && typeof assembleTimer === "object" && "unref" in assembleTimer) {
    assembleTimer.unref();
  }
  telemetryTimer = setInterval(
    () => sampleTelemetryHistory(reg, Date.now()),
    TELEMETRY_TICK_MS,
  );
  if (telemetryTimer && typeof telemetryTimer === "object" && "unref" in telemetryTimer) {
    telemetryTimer.unref();
  }
  maintenanceTimer = setInterval(runScheduledMaintenance, MAINTENANCE_INTERVAL_MS);
  if (maintenanceTimer && typeof maintenanceTimer === "object" && "unref" in maintenanceTimer) {
    maintenanceTimer.unref();
  }
}

/** Live aggregate snapshot from the server cache (no upstream call per request). */
export async function getLiveSnapshot(): Promise<DashboardSnapshot> {
  if (!registry) registry = build();
  if (!initPromise) initPromise = init(registry);
  await initPromise;
  return cached ?? assemble(registry, Date.now());
}

/**
 * High-frequency live telemetry for the SSE stream (PLA-265): the current
 * graded host snapshot plus bounded history, WITHOUT triggering a fresh
 * aggregate assembly. Requires the registry to be initialized.
 */
export async function getLiveTelemetry(): Promise<{
  telemetry: HostTelemetrySnapshot;
  history: TelemetryHistory;
  generatedAt: number;
}> {
  if (!registry) registry = build();
  if (!initPromise) initPromise = init(registry);
  await initPromise;
  const now = Date.now();
  const { telemetry, history } = currentTelemetry(registry, now);
  return { telemetry, history, generatedAt: now };
}

/** Test-only: reset module state so a fresh registry can be built. */
export function __resetLiveRegistryForTests(): void {
  if (assembleTimer) clearInterval(assembleTimer);
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  if (telemetryTimer) clearInterval(telemetryTimer);
  registry = null;
  cached = null;
  prevForEvents = null;
  alertStates = new Map();
  initPromise = null;
  assembleTimer = null;
  maintenanceTimer = null;
  telemetryTimer = null;
  lastStorageSampleAt = 0;
  lastZfsObservedAt = null;
  telemetryHistory = emptyTelemetryHistory();
  lastTelemetrySampleAt = null;
}

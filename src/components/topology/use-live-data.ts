"use client";

import { useEffect, useState } from "react";
import type {
  DashboardSnapshot,
  HostTelemetrySnapshot,
  TelemetryHistory,
} from "@/lib/types";

/**
 * Live data transport for the topology (PLA-265).
 *
 * Primary: one SSE connection to `/api/stream` (`snapshot` + `telemetry`
 * events). Fallback: interval polling of `/api/dashboard` while the SNAPSHOT
 * channel is down — the page always converges on last-known-good rather than
 * blanking.
 *
 * CHANNEL MODEL (V2.1 transport blocker): snapshot delivery and telemetry
 * delivery are tracked separately. The `/api/dashboard` fallback exists to
 * cover the snapshot channel, so ONLY a valid SSE snapshot stands it down —
 * a healthy telemetry stream must never silence snapshot fallback while
 * snapshots are dead. In the other direction the dependency is real and
 * documented: a full snapshot CONTAINS the complete telemetry payload, so
 * fresh snapshot receipt (SSE or fallback) is the telemetry channel's
 * lower-frequency fallback — telemetry merely degrades from ~2s to ~5s/7s
 * cadence, which the shell treats as healthy.
 *
 * ORDERING: snapshot and telemetry application is guarded by monotonic
 * server `generatedAt` — an older fallback response racing a newer SSE
 * snapshot, or a replayed old SSE frame, is discarded rather than becoming
 * current. A valid SSE snapshot also aborts any in-flight fallback request.
 *
 * OFFLINE is a DELIVERY judgment, never a readyState claim: an EventSource
 * that stays `open`/`connecting` while delivering nothing for the offline
 * horizon — with fallback failing too — derives `offline`.
 *
 * 24/7 hygiene:
 *  - the SSE connection is CLOSED after the tab has been hidden for a grace
 *    period and reopened on visibility, so an all-night background tab costs
 *    the server nothing;
 *  - all listeners/timers are torn down on unmount;
 *  - `frozen` (screenshot harness) never opens any connection.
 */

const FALLBACK_POLL_MS = 7_000;
/**
 * Hard per-request deadline for one fallback fetch. Strictly less than the
 * poll interval, so a slow response can never overlap the next tick or be
 * repeatedly aborted by it — a request either finishes or times out first.
 */
const FALLBACK_TIMEOUT_MS = 6_000;
const HIDDEN_CLOSE_MS = 60_000;
/** Data older than this renders the stale indicator. */
const STALE_AFTER_MS = 20_000;
const OFFLINE_AFTER_MS = 45_000;
/**
 * SSE snapshot-delivery watchdog: the server emits snapshots every ~5s, so a
 * connection that has parsed no valid SNAPSHOT frame for this long has a dead
 * snapshot channel — regardless of what `EventSource.readyState` claims, and
 * regardless of how lively the telemetry channel is. An open-but-silent,
 * heartbeat-only, telemetry-only, buffered, or malformed stream must fall
 * back to snapshot polling instead of leaving the page delayed forever.
 */
const SSE_SILENT_AFTER_MS = 15_000;
const WATCHDOG_INTERVAL_MS = 5_000;

export function liveDataIsStale(
  generatedAt: number,
  receivedAt: number,
  now: number,
  frozen: boolean,
): boolean {
  return (
    !frozen &&
    (now - generatedAt > STALE_AFTER_MS || now - receivedAt > STALE_AFTER_MS)
  );
}

export type SseState = "connecting" | "open" | "retrying" | "closed";
export type PollingState = "idle" | "active" | "failed";
export type ShellTransportState =
  | "healthy"
  | "reconnecting-with-fallback"
  | "data-delayed"
  | "offline";

export interface TransportObservation {
  /** Last applied full snapshot from ANY transport (SSE or fallback). */
  lastSnapshotReceivedAt: number;
  lastTelemetryReceivedAt: number | null;
  lastSnapshotGeneratedAt: number;
  lastTelemetryGeneratedAt: number | null;
  /**
   * Last VALID snapshot applied from the SSE channel specifically — null
   * until one arrives. Distinguishes "snapshots are fresh" (which fallback
   * can provide) from "the SSE snapshot channel itself is delivering".
   */
  lastSseSnapshotAt: number | null;
  sseState: SseState;
  pollingState: PollingState;
  lastFallbackSuccessAt: number | null;
}

/**
 * Channel-aware shell state. Freshness derives independently for the full
 * application snapshot, the high-frequency telemetry stream, and polling
 * fallback:
 *
 *  - SNAPSHOT freshness: last applied full snapshot (either transport).
 *  - TELEMETRY freshness: high-frequency events, OR fresh snapshot receipt —
 *    a full snapshot contains the complete telemetry payload, so snapshots
 *    are the telemetry channel's documented lower-frequency fallback.
 *  - OFFLINE: nothing valid received on any channel for the offline horizon
 *    AND fallback is not delivering — derived purely from delivery, so an
 *    EventSource stuck `open` or `connecting` without frames still goes
 *    offline instead of trusting readyState indefinitely.
 *  - RECONNECTING-WITH-FALLBACK: snapshot data is fresh but arriving via the
 *    fallback while the SSE snapshot channel is not delivering (or SSE is
 *    retrying) — degraded-but-covered, visibly.
 *
 * Healthy state stays silent.
 */
export function deriveShellTransportState(
  transport: TransportObservation,
  now: number,
  frozen: boolean,
): ShellTransportState {
  if (frozen) return "healthy";
  const snapshotFresh =
    now - transport.lastSnapshotReceivedAt <= STALE_AFTER_MS &&
    now - transport.lastSnapshotGeneratedAt <= STALE_AFTER_MS;
  const telemetryEventFresh =
    transport.lastTelemetryReceivedAt !== null &&
    now - transport.lastTelemetryReceivedAt <= STALE_AFTER_MS &&
    transport.lastTelemetryGeneratedAt !== null &&
    now - transport.lastTelemetryGeneratedAt <= STALE_AFTER_MS;
  const telemetryFresh = telemetryEventFresh || snapshotFresh;
  const fallbackFresh =
    transport.lastFallbackSuccessAt !== null &&
    now - transport.lastFallbackSuccessAt <= STALE_AFTER_MS;
  const lastReceipt = Math.max(
    transport.lastSnapshotReceivedAt,
    transport.lastTelemetryReceivedAt ?? 0,
    transport.lastFallbackSuccessAt ?? 0,
  );

  if (!fallbackFresh && now - lastReceipt > OFFLINE_AFTER_MS) {
    return "offline";
  }
  if (!snapshotFresh) return "data-delayed";
  const sseSnapshotFresh =
    transport.lastSseSnapshotAt !== null &&
    now - transport.lastSseSnapshotAt <= STALE_AFTER_MS;
  if (fallbackFresh && (transport.sseState === "retrying" || !sseSnapshotFresh)) {
    return "reconnecting-with-fallback";
  }
  if (!telemetryFresh) return "data-delayed";
  return "healthy";
}

interface TelemetryEvent {
  telemetry: HostTelemetrySnapshot;
  history: TelemetryHistory;
  generatedAt: number;
}

export interface LiveData {
  snapshot: DashboardSnapshot;
  /** True when the newest data is older than the freshness window. */
  stale: boolean;
  /** Epoch ms when the server produced the newest payload. */
  generatedAt: number;
  /** Epoch ms when the browser received the newest payload (transport health only). */
  receivedAt: number;
  /** Live wall-clock reference for scene aging; snapshot time only in frozen mode. */
  referenceNow: number;
  transport: TransportObservation & { shellState: ShellTransportState };
}

export function useLiveData(
  initial: DashboardSnapshot,
  opts: { scenario?: string; frozen: boolean },
): LiveData {
  const { scenario, frozen } = opts;
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(initial);
  const [transport, setTransport] = useState<TransportObservation>(() => {
    // Frozen mode anchors receive times to the snapshot clock so every
    // transport-derived surface stays independent of the machine date.
    const now = frozen ? initial.generatedAt : Date.now();
    return {
      lastSnapshotReceivedAt: now,
      lastTelemetryReceivedAt: null,
      lastSnapshotGeneratedAt: initial.generatedAt,
      lastTelemetryGeneratedAt: null,
      lastSseSnapshotAt: null,
      sseState: frozen ? "closed" : "connecting",
      pollingState: "idle",
      lastFallbackSuccessAt: null,
    };
  });
  const [staleTick, setStaleTick] = useState(0);

  useEffect(() => {
    if (frozen) return;

    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let watchdogTimer: ReturnType<typeof setInterval> | null = null;
    let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    /** In-flight guard: fallback requests never overlap or abort each other. */
    let pollInFlight = false;
    /** The in-flight request's own controller, aborted on teardown or when a valid SSE snapshot supersedes it. */
    let activePollAbort: AbortController | null = null;
    /** Last time a VALID SSE SNAPSHOT was parsed and applied (connect resets it). Telemetry frames deliberately do not count. */
    let lastSseSnapshotDeliveryAt = Date.now();
    /**
     * Monotonic generatedAt guards, local to this transport generation
     * (a scenario change re-runs the effect and resets them along with every
     * other piece of transport state). An older or replayed payload — a slow
     * fallback response racing a newer SSE snapshot, or a replayed SSE frame
     * — must never become current merely because it arrived later.
     */
    let lastAppliedSnapshotGeneratedAt = initial.generatedAt;
    let lastAppliedTelemetryGeneratedAt = initial.generatedAt;

    const query = scenario ? `?scenario=${encodeURIComponent(scenario)}` : "";

    const applySnapshot = (
      snap: DashboardSnapshot,
      source: "sse" | "fallback",
    ): boolean => {
      if (disposed || document.hidden) return false;
      if (
        typeof snap.generatedAt !== "number" ||
        !Number.isFinite(snap.generatedAt) ||
        snap.generatedAt < lastAppliedSnapshotGeneratedAt
      ) {
        return false; // stale/replayed/malformed-clock payload: never current
      }
      lastAppliedSnapshotGeneratedAt = snap.generatedAt;
      // The snapshot CONTAINS telemetry as of its generation instant, so an
      // older telemetry event must not later overwrite what it applied.
      lastAppliedTelemetryGeneratedAt = Math.max(
        lastAppliedTelemetryGeneratedAt,
        snap.generatedAt,
      );
      setSnapshot(snap);
      const receivedAt = Date.now();
      setTransport((prev) => ({
        ...prev,
        lastSnapshotGeneratedAt: snap.generatedAt,
        lastSnapshotReceivedAt: receivedAt,
        ...(source === "sse" ? { lastSseSnapshotAt: receivedAt } : {}),
      }));
      return true;
    };

    const applyTelemetry = (ev: TelemetryEvent): boolean => {
      if (disposed || document.hidden) return false;
      if (
        typeof ev.generatedAt !== "number" ||
        !Number.isFinite(ev.generatedAt) ||
        ev.generatedAt < lastAppliedTelemetryGeneratedAt
      ) {
        return false; // replayed/older than the newest applied telemetry
      }
      lastAppliedTelemetryGeneratedAt = ev.generatedAt;
      setSnapshot((prev) => ({
        ...prev,
        telemetry: ev.telemetry,
        telemetryHistory: ev.history,
      }));
      const receivedAt = Date.now();
      setTransport((prev) => ({
        ...prev,
        lastTelemetryGeneratedAt: ev.generatedAt,
        lastTelemetryReceivedAt: receivedAt,
      }));
      return true;
    };

    const stopPolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      if (!disposed) {
        setTransport((prev) => ({ ...prev, pollingState: "idle" }));
      }
    };

    // Fallback stops ONLY here: a SNAPSHOT frame counted as delivered after
    // both JSON parsing and application succeeded. `onopen`, pre-parse
    // listener entry, and TELEMETRY frames prove nothing about the snapshot
    // channel and must not silence its fallback. A superseded in-flight
    // fallback request is aborted so its (older) response can never race the
    // snapshot that just arrived.
    const markSseSnapshotDelivery = () => {
      lastSseSnapshotDeliveryAt = Date.now();
      activePollAbort?.abort();
      stopPolling();
    };

    const pollOnce = async () => {
      if (disposed || pollInFlight) return;
      pollInFlight = true;
      setTransport((prev) => ({ ...prev, pollingState: "active" }));
      const abort = new AbortController();
      activePollAbort = abort;
      let timedOut = false;
      const deadline = setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, FALLBACK_TIMEOUT_MS);
      try {
        const res = await fetch(`/api/dashboard${query}`, {
          cache: "no-store",
          signal: abort.signal,
        });
        if (res.ok) {
          // Application is generation-guarded: a response that lost the race
          // to a newer SSE snapshot is discarded (the transport still worked,
          // so the fallback success is recorded either way).
          applySnapshot((await res.json()) as DashboardSnapshot, "fallback");
          const receivedAt = Date.now();
          if (!disposed) {
            setTransport((prev) => ({
              ...prev,
              pollingState: pollTimer ? "active" : "idle",
              lastFallbackSuccessAt: receivedAt,
            }));
          }
        } else if (!disposed) {
          setTransport((prev) => ({ ...prev, pollingState: "failed" }));
        }
      } catch {
        // A deadline abort is a real failure of THIS request; a teardown
        // abort is not. Either way this request can never mark a newer one
        // failed — the controller is request-local.
        if (!disposed && (timedOut || !abort.signal.aborted)) {
          setTransport((prev) => ({ ...prev, pollingState: "failed" }));
        }
      } finally {
        clearTimeout(deadline);
        pollInFlight = false;
        if (activePollAbort === abort) activePollAbort = null;
      }
    };

    const startPolling = () => {
      if (pollTimer) return;
      void pollOnce();
      pollTimer = setInterval(() => void pollOnce(), FALLBACK_POLL_MS);
    };

    const connect = () => {
      if (disposed || source) return;
      // A fresh connection earns one full delivery window before the
      // watchdog may declare its snapshot channel silent.
      lastSseSnapshotDeliveryAt = Date.now();
      setTransport((prev) => ({ ...prev, sseState: "connecting" }));
      source = new EventSource(`/api/stream${query}`);
      source.onopen = () => {
        // `open` is a socket claim, not proof of delivery — fallback keeps
        // running until a valid snapshot frame is parsed and applied.
        if (disposed) return;
        setTransport((prev) => ({ ...prev, sseState: "open" }));
      };
      source.addEventListener("snapshot", (e) => {
        try {
          const snap = JSON.parse((e as MessageEvent).data) as DashboardSnapshot;
          if (applySnapshot(snap, "sse")) markSseSnapshotDelivery();
        } catch {
          // malformed frame: not delivery — the watchdog/fallback stay armed
        }
      });
      source.addEventListener("telemetry", (e) => {
        try {
          const ev = JSON.parse((e as MessageEvent).data) as TelemetryEvent;
          // Telemetry delivery is tracked for ITS channel only — it must not
          // stand down snapshot fallback while snapshots are dead.
          applyTelemetry(ev);
        } catch {
          // malformed frame: not delivery
        }
      });
      source.onerror = () => {
        // EventSource retries automatically; poll while it reconnects so the
        // page keeps converging on fresh data.
        if (!disposed) {
          setTransport((prev) => ({ ...prev, sseState: "retrying" }));
        }
        startPolling();
      };
    };

    const disconnect = () => {
      source?.close();
      source = null;
      stopPolling();
      if (!disposed) {
        setTransport((prev) => ({ ...prev, sseState: "closed" }));
      }
    };

    const onVisibility = () => {
      if (document.hidden) {
        if (hiddenTimer) clearTimeout(hiddenTimer);
        hiddenTimer = setTimeout(disconnect, HIDDEN_CLOSE_MS);
      } else {
        if (hiddenTimer) clearTimeout(hiddenTimer);
        hiddenTimer = null;
        // Re-establish one stream and unconditionally fetch a full snapshot.
        // The fetch is independent of `source` assignment, fixing the old
        // branch that could never run after connect() created EventSource.
        disconnect();
        connect();
        void pollOnce();
      }
    };

    connect();
    // Snapshot-delivery watchdog: even an "open" stream must keep proving
    // itself with valid SNAPSHOT frames; silence beyond the window re-arms
    // fallback polling (telemetry liveliness is irrelevant here), and
    // markSseSnapshotDelivery() stands it back down when snapshots resume.
    watchdogTimer = setInterval(() => {
      if (disposed || document.hidden || !source) return;
      if (Date.now() - lastSseSnapshotDeliveryAt > SSE_SILENT_AFTER_MS) {
        startPolling();
      }
    }, WATCHDOG_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (hiddenTimer) clearTimeout(hiddenTimer);
      if (watchdogTimer) clearInterval(watchdogTimer);
      activePollAbort?.abort();
      disconnect();
    };
  }, [scenario, frozen]);

  // Low-cost staleness ticker (4s) — drives only the freshness indicator.
  useEffect(() => {
    if (frozen) return;
    const id = setInterval(() => setStaleTick((t) => (t + 1) % 1_000_000), 4_000);
    return () => clearInterval(id);
  }, [frozen]);
  void staleTick;

  const wallNow = Date.now();
  // A delayed/replayed frame must not become "fresh" merely because it just
  // reached the browser. Server sample age carries data truth; receipt age is
  // retained separately to detect a transport that stopped delivering.
  const shellState = deriveShellTransportState(transport, wallNow, frozen);
  const stale = shellState === "data-delayed" || shellState === "offline";
  // Scene freshness must keep aging when transport delivery stops. Pinning this
  // clock to generatedAt would leave the shell saying "reconnecting" while
  // the last observed flows continued to look live indefinitely.
  const referenceNow = frozen ? snapshot.generatedAt : wallNow;
  return {
    snapshot,
    stale,
    generatedAt: transport.lastSnapshotGeneratedAt,
    receivedAt: transport.lastSnapshotReceivedAt,
    referenceNow,
    transport: { ...transport, shellState },
  };
}

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
 * events). Fallback: interval polling of `/api/dashboard` while SSE is down —
 * the page always converges on last-known-good rather than blanking.
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
 * SSE delivery watchdog: the server emits telemetry every ~2s and snapshots
 * every ~5s, so a connection that has parsed no valid frame for this long is
 * not actually delivering — regardless of what `EventSource.readyState`
 * claims. An open-but-silent, heartbeat-only, buffered, or malformed stream
 * must fall back to polling instead of leaving the page delayed forever.
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
  lastSnapshotReceivedAt: number;
  lastTelemetryReceivedAt: number | null;
  lastSnapshotGeneratedAt: number;
  lastTelemetryGeneratedAt: number | null;
  sseState: SseState;
  pollingState: PollingState;
  lastFallbackSuccessAt: number | null;
}

export function deriveShellTransportState(
  transport: TransportObservation,
  now: number,
  frozen: boolean,
): ShellTransportState {
  if (frozen) return "healthy";
  const snapshotFresh =
    now - transport.lastSnapshotReceivedAt <= STALE_AFTER_MS &&
    now - transport.lastSnapshotGeneratedAt <= STALE_AFTER_MS;
  // The initial full snapshot includes telemetry, so its receipt grants one
  // grace window while the high-frequency stream opens. Afterwards telemetry
  // events must advance independently when SSE claims to be open.
  const telemetryFresh = transport.lastTelemetryReceivedAt === null
    ? now - transport.lastSnapshotReceivedAt <= STALE_AFTER_MS
    : now - transport.lastTelemetryReceivedAt <= STALE_AFTER_MS &&
      transport.lastTelemetryGeneratedAt !== null &&
      now - transport.lastTelemetryGeneratedAt <= STALE_AFTER_MS;
  const fallbackFresh =
    transport.lastFallbackSuccessAt !== null &&
    now - transport.lastFallbackSuccessAt <= STALE_AFTER_MS;
  const lastReceipt = Math.max(
    transport.lastSnapshotReceivedAt,
    transport.lastTelemetryReceivedAt ?? 0,
    transport.lastFallbackSuccessAt ?? 0,
  );

  if (
    (transport.sseState === "retrying" || transport.sseState === "closed") &&
    !fallbackFresh &&
    now - lastReceipt > OFFLINE_AFTER_MS
  ) {
    return "offline";
  }
  if (!snapshotFresh) return "data-delayed";
  if (transport.sseState === "retrying" && fallbackFresh) {
    return "reconnecting-with-fallback";
  }
  if (transport.sseState === "open" && !telemetryFresh) return "data-delayed";
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
    /** The in-flight request's own controller, aborted only on teardown. */
    let activePollAbort: AbortController | null = null;
    /** Last time a VALID SSE frame was parsed and applied (connect resets it). */
    let lastSseDeliveryAt = Date.now();

    const query = scenario ? `?scenario=${encodeURIComponent(scenario)}` : "";

    const applySnapshot = (snap: DashboardSnapshot): boolean => {
      if (disposed || document.hidden) return false;
      setSnapshot(snap);
      const receivedAt = Date.now();
      setTransport((prev) => ({
        ...prev,
        lastSnapshotGeneratedAt: snap.generatedAt,
        lastSnapshotReceivedAt: receivedAt,
      }));
      return true;
    };

    const applyTelemetry = (ev: TelemetryEvent): boolean => {
      if (disposed || document.hidden) return false;
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

    // Fallback stops ONLY here: a frame counted as delivered after both JSON
    // parsing and application succeeded. `onopen` and pre-parse listener entry
    // prove nothing about delivery and must not silence the fallback.
    const markSseDelivery = () => {
      lastSseDeliveryAt = Date.now();
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
          applySnapshot((await res.json()) as DashboardSnapshot);
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
      // watchdog may declare it silent.
      lastSseDeliveryAt = Date.now();
      setTransport((prev) => ({ ...prev, sseState: "connecting" }));
      source = new EventSource(`/api/stream${query}`);
      source.onopen = () => {
        // `open` is a socket claim, not proof of delivery — fallback keeps
        // running until a valid frame is parsed and applied.
        if (disposed) return;
        setTransport((prev) => ({ ...prev, sseState: "open" }));
      };
      source.addEventListener("snapshot", (e) => {
        try {
          const snap = JSON.parse((e as MessageEvent).data) as DashboardSnapshot;
          if (applySnapshot(snap)) markSseDelivery();
        } catch {
          // malformed frame: not delivery — the watchdog/fallback stay armed
        }
      });
      source.addEventListener("telemetry", (e) => {
        try {
          const ev = JSON.parse((e as MessageEvent).data) as TelemetryEvent;
          if (applyTelemetry(ev)) markSseDelivery();
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
    // Delivery watchdog: even an "open" stream must keep proving itself with
    // valid frames; silence beyond the window re-arms fallback polling, and
    // markSseDelivery() stands it back down when real delivery resumes.
    watchdogTimer = setInterval(() => {
      if (disposed || document.hidden || !source) return;
      if (Date.now() - lastSseDeliveryAt > SSE_SILENT_AFTER_MS) startPolling();
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

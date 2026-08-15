"use client";

import { useEffect, useRef, useState } from "react";
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
const HIDDEN_CLOSE_MS = 60_000;
/** Data older than this renders the stale indicator. */
const STALE_AFTER_MS = 20_000;

interface TelemetryEvent {
  telemetry: HostTelemetrySnapshot;
  history: TelemetryHistory;
  generatedAt: number;
}

export interface LiveData {
  snapshot: DashboardSnapshot;
  /** True when the newest data is older than the freshness window. */
  stale: boolean;
  /** Epoch ms of the last received payload. */
  receivedAt: number;
}

export function useLiveData(
  initial: DashboardSnapshot,
  opts: { scenario?: string; frozen: boolean },
): LiveData {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(initial);
  const [receivedAt, setReceivedAt] = useState<number>(() => Date.now());
  const [staleTick, setStaleTick] = useState(0);
  const receivedAtRef = useRef(receivedAt);
  receivedAtRef.current = receivedAt;

  const { scenario, frozen } = opts;

  useEffect(() => {
    if (frozen) return;

    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
    let pollAbort: AbortController | null = null;
    let disposed = false;

    const query = scenario ? `?scenario=${encodeURIComponent(scenario)}` : "";

    const applySnapshot = (snap: DashboardSnapshot) => {
      if (disposed || document.hidden) return;
      setSnapshot(snap);
      setReceivedAt(Date.now());
    };

    const applyTelemetry = (ev: TelemetryEvent) => {
      if (disposed || document.hidden) return;
      setSnapshot((prev) => ({
        ...prev,
        telemetry: ev.telemetry,
        telemetryHistory: ev.history,
      }));
      setReceivedAt(Date.now());
    };

    const stopPolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    };

    const pollOnce = async () => {
      try {
        pollAbort?.abort();
        pollAbort = new AbortController();
        const res = await fetch(`/api/dashboard${query}`, {
          cache: "no-store",
          signal: pollAbort.signal,
        });
        if (res.ok) applySnapshot((await res.json()) as DashboardSnapshot);
      } catch {
        // keep last-known-good; the stale indicator communicates the gap
      }
    };

    const startPolling = () => {
      if (pollTimer) return;
      void pollOnce();
      pollTimer = setInterval(() => void pollOnce(), FALLBACK_POLL_MS);
    };

    const connect = () => {
      if (disposed || source) return;
      source = new EventSource(`/api/stream${query}`);
      source.addEventListener("snapshot", (e) => {
        stopPolling(); // SSE delivering → polling unnecessary
        try {
          applySnapshot(JSON.parse((e as MessageEvent).data) as DashboardSnapshot);
        } catch {
          // malformed frame: ignore
        }
      });
      source.addEventListener("telemetry", (e) => {
        try {
          applyTelemetry(JSON.parse((e as MessageEvent).data) as TelemetryEvent);
        } catch {
          // malformed frame: ignore
        }
      });
      source.onerror = () => {
        // EventSource retries automatically; poll while it reconnects so the
        // page keeps converging on fresh data.
        startPolling();
      };
    };

    const disconnect = () => {
      source?.close();
      source = null;
      stopPolling();
    };

    const onVisibility = () => {
      if (document.hidden) {
        if (hiddenTimer) clearTimeout(hiddenTimer);
        hiddenTimer = setTimeout(disconnect, HIDDEN_CLOSE_MS);
      } else {
        if (hiddenTimer) clearTimeout(hiddenTimer);
        hiddenTimer = null;
        connect();
        // Refresh immediately after returning to the tab.
        if (!source) startPolling();
      }
    };

    connect();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (hiddenTimer) clearTimeout(hiddenTimer);
      pollAbort?.abort();
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

  const stale = !frozen && Date.now() - receivedAt > STALE_AFTER_MS;
  return { snapshot, stale, receivedAt };
}

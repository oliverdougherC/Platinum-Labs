"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CommandPalette } from "@/components/command-palette";
import {
  ConnectionWarningIcon,
  MediaRequestIcon,
  OBSERVATORY_CONTROL_CLASS,
} from "@/components/ui/icons";
import { MediaSearch } from "@/components/media-search";
import { DetailDrawer } from "@/components/topology/detail-drawer";
import { MetricsRail } from "@/components/topology/metrics-rail";
import {
  NotificationBell,
  NotificationDrawer,
  useNotificationCenter,
} from "@/components/topology/notification-center";
import { TopologyScene, type TopologySelection } from "@/components/topology/scene";
import {
  useLiveData,
  type ShellTransportState,
} from "@/components/topology/use-live-data";
import { appConfig } from "@/lib/config";
import type { QuickLink } from "@/lib/quicklinks";
import type { AttentionItem, DashboardSnapshot } from "@/lib/types";
import type { ServiceId } from "@/lib/scene/model";

/**
 * V2 app shell (PLA-263): one 100dvh composition — thin top chrome, the
 * full-bleed topology scene, and the exact-metrics rail. Notifications and
 * details are overlays; nothing on the primary surface reflows, ever.
 */

export interface SeerrAvailability {
  search: boolean;
  requests: boolean;
}

export interface InitialPanels {
  /** Deterministic open-state for the screenshot harness (dev only). */
  panel?: "notifications" | null;
  drawer?: string | null;
}

function TransportStatus({ state }: { state: ShellTransportState }) {
  if (state === "healthy") return null;
  const tone = state === "offline" ? "text-danger" : "text-warn";
  if (state === "reconnecting-with-fallback") {
    return (
      <span
        role="status"
        aria-label="Live stream reconnecting; fallback active"
        title="Live stream reconnecting · fallback active"
        className={`${OBSERVATORY_CONTROL_CLASS} ${tone}`}
      >
        <ConnectionWarningIcon />
        <span className="hidden xl:inline">Fallback</span>
      </span>
    );
  }
  return (
    <span
      role="status"
      aria-label={state === "offline" ? "Dashboard offline" : "Dashboard data delayed"}
      title={state === "offline" ? "Dashboard offline" : "Dashboard data delayed"}
      className={`${OBSERVATORY_CONTROL_CLASS} ${tone}`}
    >
      <ConnectionWarningIcon />
      <span>{state === "offline" ? "Offline" : "Delayed"}</span>
    </span>
  );
}

function parseDrawer(value: string | null | undefined): TopologySelection | null {
  if (!value) return null;
  if (value === "host") return { kind: "host" };
  if (value === "docker") return { kind: "docker" };
  if (value.startsWith("pool:")) return { kind: "pool", name: value.slice(5) };
  if (value.startsWith("service:")) {
    return { kind: "service", id: value.slice(8) as ServiceId };
  }
  if (value.startsWith("container:")) {
    return { kind: "container", name: value.slice(10) };
  }
  return null;
}

export function TopologyApp({
  initial,
  seerr,
  quickLinks,
  scenario,
  frozen,
  initialPanels,
  transportOverride,
  devControls = false,
}: {
  initial: DashboardSnapshot;
  seerr: SeerrAvailability;
  quickLinks: QuickLink[];
  scenario?: string;
  /** Screenshot-harness mode: no transport, no clock-driven changes, animations paused. */
  frozen: boolean;
  initialPanels?: InitialPanels;
  /** Deterministic dev-only shell state used by the regression harness. */
  transportOverride?: ShellTransportState;
  /** Enables the same-page scenario hook for the motion harness (dev only). */
  devControls?: boolean;
}) {
  // Same-mounted-scene fixture (PLA-270): the motion harness switches the fake
  // scenario UNDER the live renderer — no navigation, no reload — so the
  // recording demonstrates the interpolation system, not a page load.
  const [scenarioOverride, setScenarioOverride] = useState<string | null>(null);
  useEffect(() => {
    if (!devControls) return;
    const w = window as unknown as { __homelabSetScenario?: (s: string) => void };
    w.__homelabSetScenario = (s: string) => setScenarioOverride(s);
    return () => {
      delete w.__homelabSetScenario;
    };
  }, [devControls]);

  const { snapshot, referenceNow, transport } = useLiveData(initial, {
    scenario: scenarioOverride ?? scenario,
    frozen,
  });
  const [selection, setSelection] = useState<TopologySelection | null>(
    () => parseDrawer(initialPanels?.drawer) ?? null,
  );
  const [notifOpen, setNotifOpen] = useState(initialPanels?.panel === "notifications");
  const [mediaSearch, setMediaSearch] = useState<{ open: boolean; seed: string }>({
    open: false,
    seed: "",
  });
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReducedMotion(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // Dev-only geometry debug overlay (?debug=geometry). Never in production.
  const [debugGeometry] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    if (process.env.NODE_ENV === "production") return false;
    return new URLSearchParams(window.location.search).get("debug") === "geometry";
  });

  const shellTransportState = transportOverride ?? transport.shellState;
  const transportAttention = useMemo<AttentionItem[]>(() => {
    if (
      shellTransportState !== "data-delayed" &&
      shellTransportState !== "offline"
    ) {
      return [];
    }
    const offline = shellTransportState === "offline";
    const lastSeen = Math.max(
      transport.lastSnapshotReceivedAt,
      transport.lastTelemetryReceivedAt ?? 0,
      transport.lastFallbackSuccessAt ?? 0,
    );
    return [{
      ruleId: offline ? "shell.transport.offline" : "shell.transport.delayed",
      alertId: offline ? "shell.transport.offline" : "shell.transport.delayed",
      severity: offline ? "critical" : "warning",
      title: offline ? "Dashboard offline" : "Dashboard data delayed",
      detail: offline
        ? "Neither the live stream nor snapshot fallback is responding."
        : "The full snapshot or high-frequency telemetry stream is delayed.",
      source: "host",
      firstSeenAt: lastSeen + 20_000,
      // referenceNow, never Date.now(): with a frozen snapshot plus a
      // transport override, the harness must render identical pixels on any
      // machine date (V2.1 determinism blocker).
      lastSeenAt: referenceNow,
    }];
  }, [shellTransportState, transport, referenceNow]);
  const notifications = useNotificationCenter(
    [...snapshot.attention, ...transportAttention],
    frozen,
    referenceNow,
  );
  const activeCount = notifications.groups.reduce((sum, g) => sum + g.items.length, 0);

  const closeMediaSearch = useCallback(() => {
    setMediaSearch({ open: false, seed: "" });
  }, []);

  const closeTransientOverlays = useCallback(() => {
    setNotifOpen(false);
    closeMediaSearch();
  }, [closeMediaSearch]);

  const openMediaSearch = useCallback((seed = "") => {
    closeTransientOverlays();
    setSelection(null);
    setMediaSearch({ open: true, seed });
  }, [closeTransientOverlays]);

  const prepareModalOpen = useCallback(() => {
    closeTransientOverlays();
    setSelection(null);
  }, [closeTransientOverlays]);

  const onSelect = useCallback((sel: TopologySelection) => {
    closeTransientOverlays();
    setSelection((prev) =>
      prev &&
      JSON.stringify(prev) === JSON.stringify(sel)
        ? null
        : sel,
    );
  }, [closeTransientOverlays]);

  return (
    <div
      data-app-shell
      data-motion={frozen || reducedMotion ? "off" : "on"}
      className="flex h-dvh w-full flex-col overflow-hidden bg-bg"
    >
      {/* thin critical edge indicator — never a banner */}
      {notifications.critical && (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 z-20 w-[2px] bg-danger/70"
          aria-hidden
        />
      )}

      <header className="flex h-12 shrink-0 items-center justify-between px-5">
        <div className="flex items-baseline gap-3">
          <h1 className="text-[13px] uppercase tracking-[0.24em] text-muted">
            {appConfig.appName}
          </h1>
          <span className="text-[10px] uppercase tracking-[0.14em] text-faint">
            {snapshot.mode === "fake" ? "demo data" : "live"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div
            role="group"
            aria-label="Observatory controls"
            className="flex items-center gap-0.5 rounded-xl border border-hairline/50 bg-transparent p-0.5"
          >
            <TransportStatus state={shellTransportState} />
            {seerr.search && (
              <button
                type="button"
                onClick={() => openMediaSearch()}
                className={OBSERVATORY_CONTROL_CLASS}
                aria-label="Request media"
                aria-haspopup="dialog"
                aria-expanded={mediaSearch.open}
                title="Request media"
              >
                <MediaRequestIcon />
                <span className="hidden xl:inline">Request media</span>
              </button>
            )}
            <CommandPalette
              snapshot={snapshot}
              links={quickLinks}
              now={referenceNow}
              onMediaSearch={seerr.search ? openMediaSearch : undefined}
              onOpen={prepareModalOpen}
            />
            <NotificationBell
              count={activeCount}
              critical={notifications.critical}
              open={notifOpen}
              onToggle={() => {
                closeMediaSearch();
                setSelection(null);
                setNotifOpen((o) => !o);
              }}
            />
          </div>
        </div>
      </header>

      <main className="relative min-h-0 flex-1">
        <TopologyScene
          snapshot={snapshot}
          now={referenceNow}
          seerrConfigured={seerr.search}
          frozen={frozen}
          reducedMotion={reducedMotion}
          debug={debugGeometry}
          onSelect={onSelect}
        />
      </main>

      <MetricsRail snapshot={snapshot} />

      <NotificationDrawer
        open={notifOpen}
        groups={notifications.groups}
        hiddenCount={notifications.hiddenCount}
        prefs={notifications.prefs}
        now={referenceNow}
        onUpdatePrefs={notifications.update}
        onClose={() => setNotifOpen(false)}
      />
      <DetailDrawer
        selection={selection}
        snapshot={snapshot}
        now={referenceNow}
        onClose={() => setSelection(null)}
      />

      {seerr.search && (
        <MediaSearch
          open={mediaSearch.open}
          initialQuery={mediaSearch.seed}
          requestsEnabled={seerr.requests}
          onClose={closeMediaSearch}
        />
      )}
    </div>
  );
}

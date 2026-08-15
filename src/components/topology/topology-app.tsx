"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CommandPalette } from "@/components/command-palette";
import { MediaSearch } from "@/components/media-search";
import { DetailDrawer } from "@/components/topology/detail-drawer";
import { MetricsRail } from "@/components/topology/metrics-rail";
import {
  NotificationBell,
  NotificationDrawer,
  useNotificationCenter,
} from "@/components/topology/notification-center";
import { TopologyScene, type TopologySelection } from "@/components/topology/scene";
import { useLiveData } from "@/components/topology/use-live-data";
import { deriveFlows } from "@/lib/topology/activity";
import { appConfig } from "@/lib/config";
import { formatRelativeTime } from "@/lib/utils";
import type { QuickLink } from "@/lib/quicklinks";
import type { DashboardSnapshot } from "@/lib/types";
import type { ServiceId } from "@/lib/topology/layout";

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

function Freshness({ receivedAt, stale, frozen }: { receivedAt: number; stale: boolean; frozen: boolean }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (frozen) return;
    const id = setInterval(() => force((n) => n + 1), 5_000);
    return () => clearInterval(id);
  }, [frozen]);
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-faint">
      <span
        className={`h-1.5 w-1.5 rounded-full ${stale ? "bg-warn" : "bg-ok"}`}
        style={{ opacity: 0.8 }}
        aria-hidden
      />
      {stale ? "reconnecting…" : frozen ? "frozen" : `updated ${formatRelativeTime(receivedAt, Date.now())}`}
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
  return null;
}

export function TopologyApp({
  initial,
  seerr,
  quickLinks,
  scenario,
  frozen,
  initialPanels,
}: {
  initial: DashboardSnapshot;
  seerr: SeerrAvailability;
  quickLinks: QuickLink[];
  scenario?: string;
  /** Screenshot-harness mode: no transport, no clock-driven changes, animations paused. */
  frozen: boolean;
  initialPanels?: InitialPanels;
}) {
  const { snapshot, stale, receivedAt } = useLiveData(initial, { scenario, frozen });
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

  const referenceNow = frozen ? snapshot.generatedAt : receivedAt;
  const flows = useMemo(
    () => deriveFlows(snapshot, referenceNow),
    [snapshot, referenceNow],
  );

  const notifications = useNotificationCenter(snapshot.attention, frozen);
  const activeCount = notifications.groups.reduce((sum, g) => sum + g.items.length, 0);

  const openMediaSearch = useCallback(
    (seed = "") => setMediaSearch({ open: true, seed }),
    [],
  );

  const onSelect = useCallback((sel: TopologySelection) => {
    setNotifOpen(false);
    setSelection((prev) =>
      prev &&
      JSON.stringify(prev) === JSON.stringify(sel)
        ? null
        : sel,
    );
  }, []);

  return (
    <div
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
        <div className="flex items-center gap-3">
          <Freshness receivedAt={receivedAt} stale={stale} frozen={frozen} />
          {seerr.search && (
            <button
              type="button"
              onClick={() => openMediaSearch()}
              className="rounded-full px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] text-faint ring-1 ring-hairline transition-colors hover:text-muted"
            >
              ⌕ request media
            </button>
          )}
          <CommandPalette
            snapshot={snapshot}
            links={quickLinks}
            now={referenceNow}
            onMediaSearch={seerr.search ? openMediaSearch : undefined}
          />
          <NotificationBell
            count={activeCount}
            critical={notifications.critical}
            open={notifOpen}
            onToggle={() => {
              setSelection(null);
              setNotifOpen((o) => !o);
            }}
          />
        </div>
      </header>

      <main className="relative min-h-0 flex-1">
        <TopologyScene snapshot={snapshot} flows={flows} onSelect={onSelect} />
      </main>

      <MetricsRail snapshot={snapshot} />

      <NotificationDrawer
        open={notifOpen}
        groups={notifications.groups}
        hiddenCount={notifications.hiddenCount}
        prefs={notifications.prefs}
        onUpdatePrefs={notifications.update}
        onClose={() => setNotifOpen(false)}
      />
      <DetailDrawer
        selection={selection}
        snapshot={snapshot}
        onClose={() => setSelection(null)}
      />

      {seerr.search && (
        <MediaSearch
          open={mediaSearch.open}
          initialQuery={mediaSearch.seed}
          requestsEnabled={seerr.requests}
          onClose={() => setMediaSearch({ open: false, seed: "" })}
        />
      )}
    </div>
  );
}

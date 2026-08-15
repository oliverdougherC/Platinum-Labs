"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { appConfig } from "@/lib/config";
import { AttentionSummary } from "@/components/modules/attention-summary";
import { MediaModule } from "@/components/modules/media-module";
import { StorageModule } from "@/components/modules/storage-module";
import { ActivityFeed } from "@/components/modules/activity-feed";
import { QuickAccess } from "@/components/modules/quick-access";
import { ConnectorHealthBar } from "@/components/modules/connector-health-bar";
import { CommandPalette } from "@/components/command-palette";
import { cn } from "@/lib/utils";
import type { QuickLink } from "@/lib/quicklinks";
import type { DashboardSnapshot } from "@/lib/types";

/**
 * Live dashboard shell (PLA-186).
 *
 * Server-rendered with an initial snapshot for instant first paint, then polls
 * the aggregate `/api/dashboard` endpoint on a fixed cadence and updates React
 * state in place — no full-page reload, no layout shift (stable keys + fixed
 * grid + min-height panels). If a poll fails, the last snapshot stays on screen
 * and a "stale" indicator appears, so unavailable state is shown, never hidden.
 *
 * Browser cadence here is independent of upstream service polling (which the
 * server scheduler owns), so extra tabs never multiply real API calls.
 */
export function LiveDashboard({
  initial,
  scenario,
  quickLinks = [],
  pollMs = 7_000,
}: {
  initial: DashboardSnapshot;
  scenario?: string;
  quickLinks?: QuickLink[];
  pollMs?: number;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [lastUpdated, setLastUpdated] = useState<number>(initial.generatedAt);
  const [stale, setStale] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const poll = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const url = scenario
        ? `/api/dashboard?scenario=${encodeURIComponent(scenario)}`
        : "/api/dashboard";
      const res = await fetch(url, { signal: ac.signal, cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = (await res.json()) as DashboardSnapshot;
      setSnapshot(next);
      setLastUpdated(next.generatedAt || Date.now());
      setStale(false);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      // Keep the last-known snapshot on screen; mark the view as stale.
      setStale(true);
    }
  }, [scenario]);

  useEffect(() => {
    const id = setInterval(poll, pollMs);
    return () => {
      clearInterval(id);
      abortRef.current?.abort();
    };
  }, [poll, pollMs]);

  // Reset to the freshest server-rendered snapshot when the scenario changes.
  useEffect(() => {
    setSnapshot(initial);
    setLastUpdated(initial.generatedAt);
    setStale(false);
  }, [initial]);

  const now = snapshot.generatedAt;

  return (
    <>
      <header className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="text-title font-medium tracking-tight text-fg">
            {appConfig.appName}
          </h1>
          <span className="rounded-full px-2 py-0.5 text-eyebrow uppercase tracking-[0.14em] text-faint ring-1 ring-hairline">
            {snapshot.mode} data
          </span>
        </div>
        <Freshness lastUpdated={lastUpdated} stale={stale} />
      </header>

      <AttentionSummary snapshot={snapshot} now={now} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <MediaModule snapshot={snapshot} now={now} />
        <div className="flex flex-col gap-6">
          <StorageModule snapshot={snapshot} now={now} />
          <ActivityFeed snapshot={snapshot} now={now} />
        </div>
      </div>

      <div className="mt-auto flex flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <QuickAccess links={quickLinks} />
          <CommandPalette snapshot={snapshot} links={quickLinks} now={now} />
        </div>
        <ConnectorHealthBar snapshot={snapshot} now={now} />
      </div>
    </>
  );
}

/** Small, ticking "updated Ns ago" indicator with a stale flag. */
function Freshness({ lastUpdated, stale }: { lastUpdated: number; stale: boolean }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const seconds = Math.max(0, Math.round((Date.now() - lastUpdated) / 1000));
  const label = seconds < 2 ? "just now" : `${seconds}s ago`;

  return (
    <span className="flex items-center gap-2 text-meta">
      <span
        aria-hidden
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          stale ? "bg-warn" : "bg-ok",
        )}
      />
      <span className={cn("tnum", stale ? "text-warn" : "text-muted")}>
        {stale ? "reconnecting…" : `updated ${label}`}
      </span>
    </span>
  );
}

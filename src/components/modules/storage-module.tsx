import { Panel, PanelHeader } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { ProgressBar } from "@/components/ui/progress-bar";
import { StatusDot } from "@/components/status-dot";
import { StorageTrendChart } from "@/components/charts/storage-trend-chart";
import {
  capacityBand,
  healthById,
  storagePresentation,
  storageVisualState,
} from "@/lib/dashboard/derive";
import { projectCapacity, projectionLabel, type StoragePoint } from "@/lib/dashboard/projection";
import { appConfig } from "@/lib/config";
import { formatBytes, formatPercent, formatRelativeTime } from "@/lib/utils";
import type { DashboardSnapshot, ZfsPool, ZfsScanState } from "@/lib/types";

/** Minimum distinct history points before the 30-day trend chart is meaningful. */
const MIN_TREND_POINTS = 3;

/**
 * ZFS storage — the secondary primary surface (PLA-175 / PLA-188). Per-pool
 * capacity, health, scan/scrub state, the real 30-day used-capacity trend, and a
 * subordinate capacity projection when enough real history exists.
 *
 * Empty/unavailable states are health-aware (PLA-194): a configured-but-
 * unreachable ZFS source reads as "unavailable", NOT "not configured", and an
 * empty pool set only reads as "no pools" when the source is genuinely healthy.
 */
export function StorageModule({
  snapshot,
  now,
}: {
  snapshot: DashboardSnapshot;
  now: number;
}) {
  const state = storageVisualState(snapshot);
  const pools = snapshot.zfs.pools;
  const presentation = storagePresentation(snapshot, now);
  const configError = healthById(snapshot.health, "zfs")?.configError ?? null;

  // No usable pool data: say WHY (unconfigured / misconfigured / unavailable /
  // stale-with-no-LKG), never a misleading "no pools configured".
  const empty = pools.length === 0;
  const emptyMessage =
    presentation === "unconfigured"
      ? "Storage is not configured."
      : presentation === "misconfigured"
        ? configError
          ? `Storage is misconfigured: ${configError}.`
          : "Storage is misconfigured."
        : presentation === "unavailable"
          ? "Storage data is unavailable."
          : presentation === "stale"
            ? "Storage data is unavailable (last sync failed)."
            : "No pools reported."; // healthy + genuinely empty

  const stale = presentation === "stale" && !empty;
  const trend = storageTrend(snapshot);

  return (
    <Panel state={state} className="flex min-h-[19rem] flex-col">
      <PanelHeader
        title="Storage"
        id="storage-heading"
        trailing={stale ? <Badge tone="warn">stale</Badge> : null}
      />
      {empty ? (
        <p className="text-body text-faint">{emptyMessage}</p>
      ) : (
        <>
          <ul className="flex flex-col gap-5">
            {pools.map((pool) => (
              <PoolRow
                key={pool.name}
                pool={pool}
                now={now}
                history={poolHistory(snapshot, pool.name)}
              />
            ))}
          </ul>
          {trend ? (
            <div className="mt-5">
              <StorageTrendChart
                data={trend.data}
                series={trend.series}
                label="Used capacity · 30d"
              />
            </div>
          ) : null}
        </>
      )}
    </Panel>
  );
}

/**
 * The real persisted 30-day used-capacity trend, or null when there is not
 * enough history for it to be meaningful (a fresh install shows current usage
 * without pretending a trend exists). Subordinate to the current capacity rows.
 */
function storageTrend(
  snapshot: DashboardSnapshot,
): { data: Array<{ t: number } & Record<string, number>>; series: string[] } | null {
  const rows = snapshot.history?.storage ?? [];
  const series = snapshot.history?.storageSeries ?? [];
  if (series.length === 0 || rows.length < MIN_TREND_POINTS) return null;
  return { data: rows, series };
}

/** Extract a pool's used-bytes series from the aggregate history window. */
function poolHistory(snapshot: DashboardSnapshot, pool: string): StoragePoint[] {
  const rows = snapshot.history?.storage ?? [];
  const out: StoragePoint[] = [];
  for (const row of rows) {
    const used = row[pool];
    if (typeof used === "number") out.push({ t: row.t, usedBytes: used });
  }
  return out;
}

const BAND_TONE = {
  ok: "accent",
  warning: "warn",
  critical: "danger",
} as const;

const SCAN_LABEL: Record<ZfsScanState, string | null> = {
  none: null,
  scrubbing: "Scrubbing…",
  resilvering: "Resilvering…",
  finished: null,
};

function PoolRow({
  pool,
  now,
  history,
}: {
  pool: ZfsPool;
  now: number;
  history: StoragePoint[];
}) {
  const { thresholds } = appConfig;
  const band = capacityBand(
    pool.capacityFraction,
    thresholds.storageWarnFraction,
    thresholds.storageCriticalFraction,
  );
  const healthy = pool.health === "ONLINE";

  const { projection, growth30dBytes } = projectCapacity(history, {
    totalBytes: pool.totalBytes,
    now,
    thresholdFraction: thresholds.storageWarnFraction,
  });
  const scanLabel = SCAN_LABEL[pool.scan];

  return (
    <li className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-body font-medium text-fg">{pool.name}</span>
        <span className="tnum text-metric font-medium leading-none">
          {formatPercent(pool.capacityFraction)}
        </span>
      </div>

      <ProgressBar
        value={pool.capacityFraction}
        tone={BAND_TONE[band]}
        label={`${pool.name} capacity`}
      />

      <div className="flex items-center justify-between">
        <span className="tnum text-meta text-muted">
          {formatBytes(pool.usedBytes)} / {formatBytes(pool.totalBytes)}
          {growth30dBytes && growth30dBytes > 0 ? (
            <span className="text-faint"> · +{formatBytes(growth30dBytes)}/30d</span>
          ) : null}
        </span>
        <div className="flex items-center gap-2">
          {pool.scrubErrors > 0 ? (
            <Badge tone="danger">{pool.scrubErrors} scrub errors</Badge>
          ) : null}
          <StatusDot
            status={healthy ? "healthy" : "degraded"}
            label={pool.health}
          />
        </div>
      </div>

      {/* Subordinate lines: scan state, projection, last scrub. */}
      <div className="flex flex-wrap items-center gap-x-3 text-meta text-faint">
        {scanLabel ? <span className="text-warn">{scanLabel}</span> : null}
        {projection ? (
          <span title={new Date(projection.etaAt).toLocaleString()}>
            {projectionLabel(projection)}
          </span>
        ) : null}
        {pool.lastScrubAt ? (
          <span>Scrubbed {formatRelativeTime(pool.lastScrubAt, now)}</span>
        ) : null}
      </div>
    </li>
  );
}

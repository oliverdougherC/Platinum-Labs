import { Panel, PanelHeader } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { ProgressBar } from "@/components/ui/progress-bar";
import { StatusDot } from "@/components/status-dot";
import { capacityBand, storageVisualState } from "@/lib/dashboard/derive";
import { projectCapacity, projectionLabel, type StoragePoint } from "@/lib/dashboard/projection";
import { appConfig } from "@/lib/config";
import { formatBytes, formatPercent, formatRelativeTime } from "@/lib/utils";
import type { DashboardSnapshot, ZfsPool, ZfsScanState } from "@/lib/types";

/**
 * ZFS storage — the secondary primary surface (PLA-175 / PLA-188). Per-pool
 * capacity, health, scan/scrub state, 30-day growth, and a subordinate capacity
 * projection when enough real history exists. Empty pool set reads as "not
 * configured", distinct from a failure.
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

  return (
    <Panel state={state} className="flex min-h-[19rem] flex-col">
      <PanelHeader title="Storage" id="storage-heading" />
      {pools.length === 0 ? (
        <p className="text-body text-faint">No pools configured.</p>
      ) : (
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
      )}
    </Panel>
  );
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

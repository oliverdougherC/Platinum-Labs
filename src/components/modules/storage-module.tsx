import { Panel, PanelHeader } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { ProgressBar } from "@/components/ui/progress-bar";
import { StatusDot } from "@/components/status-dot";
import { capacityBand, storageVisualState } from "@/lib/dashboard/derive";
import { appConfig } from "@/lib/config";
import { formatBytes, formatPercent, formatRelativeTime } from "@/lib/utils";
import type { DashboardSnapshot, ZfsPool } from "@/lib/types";

/**
 * ZFS storage — the secondary primary surface (PLA-175). Per-pool capacity,
 * health, and scrub recency. Attention state elevates a degraded/near-full
 * pool. Empty pool set reads as "not configured", distinct from a failure.
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
            <PoolRow key={pool.name} pool={pool} now={now} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

const BAND_TONE = {
  ok: "accent",
  warning: "warn",
  critical: "danger",
} as const;

function PoolRow({ pool, now }: { pool: ZfsPool; now: number }) {
  const { thresholds } = appConfig;
  const band = capacityBand(
    pool.capacityFraction,
    thresholds.storageWarnFraction,
    thresholds.storageCriticalFraction,
  );
  const healthy = pool.health === "ONLINE";

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

      {pool.lastScrubAt ? (
        <span className="text-meta text-faint">
          Scrubbed {formatRelativeTime(pool.lastScrubAt, now)}
        </span>
      ) : null}
    </li>
  );
}

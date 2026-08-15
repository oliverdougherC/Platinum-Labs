"use client";

import { useMemo } from "react";
import { formatBytes, formatRate } from "@/lib/format/bytes";
import { formatPercent } from "@/lib/utils";
import type {
  DashboardSnapshot,
  TelemetryDomain,
  TelemetryHistoryPoint,
} from "@/lib/types";

/**
 * Exact-metrics rail (PLA-269): one thin strip of precise numbers along the
 * bottom edge. Typography and hairline separators only — no cards. Tabular
 * numerals keep the strip stable while values change. Missing telemetry reads
 * as an explicit em dash + status word, never zero.
 */

function Spark({ points, max }: { points: TelemetryHistoryPoint[]; max?: number }) {
  const path = useMemo(() => {
    if (points.length < 2) return null;
    const w = 56;
    const h = 16;
    const t0 = points[0]!.t;
    const t1 = points[points.length - 1]!.t;
    const span = Math.max(1, t1 - t0);
    const peak = max ?? Math.max(...points.map((p) => p.v), 1e-9);
    return points
      .map((p, i) => {
        const x = ((p.t - t0) / span) * w;
        const y = h - Math.min(p.v / peak, 1) * (h - 2) - 1;
        return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ");
  }, [points, max]);
  if (!path) return null;
  return (
    <svg width={56} height={16} className="shrink-0 opacity-60" aria-hidden>
      <path d={path} className="fill-none stroke-accent" strokeWidth={1} />
    </svg>
  );
}

function Cell({
  label,
  value,
  status,
  spark,
  title,
}: {
  label: string;
  value: string | null;
  status?: TelemetryDomain<unknown>["status"];
  spark?: React.ReactNode;
  title?: string;
}) {
  const missing = value === null;
  return (
    <div className="flex min-w-0 items-baseline gap-2 px-4" title={title}>
      <span className="text-[10.5px] uppercase tracking-[0.16em] text-faint">
        {label}
      </span>
      {missing ? (
        <span className="text-[12.5px] text-faint">
          — <span className="text-[10px]">{status === "not-configured" ? "not set up" : status}</span>
        </span>
      ) : (
        <span
          className={`tnum whitespace-nowrap text-[12.5px] ${
            status === "stale" ? "text-faint" : "text-muted"
          }`}
        >
          {value}
          {status === "stale" && <span className="ml-1 text-[10px]">stale</span>}
        </span>
      )}
      {spark}
    </div>
  );
}

export function MetricsRail({ snapshot }: { snapshot: DashboardSnapshot }) {
  const t = snapshot.telemetry;
  const h = snapshot.telemetryHistory;

  const docker = t.docker;
  return (
    <footer className="flex h-11 shrink-0 items-center divide-x divide-hairline overflow-hidden border-t border-hairline">
      <Cell
        label="cpu"
        status={t.cpu.status}
        value={
          t.cpu.value
            ? `${formatPercent(t.cpu.value.totalFraction)} · load ${t.cpu.value.load1.toFixed(2)}`
            : null
        }
        spark={h ? <Spark points={h.cpuTotal} max={1} /> : undefined}
      />
      <Cell
        label="mem"
        status={t.memory.status}
        value={
          t.memory.value
            ? `${formatBytes(t.memory.value.usedBytes, { system: "binary" })} / ${formatBytes(t.memory.value.totalBytes, { system: "binary", digits: 0 })}`
            : null
        }
      />
      <Cell
        label="gpu"
        status={t.gpu.status}
        title={t.gpu.value?.name}
        value={
          t.gpu.value
            ? `${formatPercent(t.gpu.value.utilizationFraction)} · ${formatBytes(t.gpu.value.vramUsedBytes, { system: "binary" })} vram${
                t.gpu.value.temperatureC !== null ? ` · ${t.gpu.value.temperatureC}°` : ""
              }`
            : null
        }
      />
      <Cell
        label="net"
        status={t.network.status}
        value={
          t.network.value
            ? `↓ ${formatRate(t.network.value.rxBps)} ↑ ${formatRate(t.network.value.txBps)}`
            : null
        }
        spark={h ? <Spark points={h.netRx} /> : undefined}
      />
      <Cell
        label="disk"
        status={t.disk.status}
        value={
          t.disk.value
            ? `r ${formatRate(t.disk.value.readBps)} w ${formatRate(t.disk.value.writeBps)}`
            : null
        }
        spark={h ? <Spark points={h.diskWrite} /> : undefined}
      />
      <Cell
        label="docker"
        status={docker.status}
        value={
          docker.value
            ? `${docker.value.running}/${docker.value.total} running${
                docker.value.unhealthy > 0 ? ` · ${docker.value.unhealthy} unhealthy` : ""
              }`
            : null
        }
      />
      {t.arc.value && (
        <Cell
          label="arc"
          status={t.arc.status}
          value={`${formatBytes(t.arc.value.sizeBytes, { system: "binary" })}${
            t.arc.value.hitRatio !== null
              ? ` · ${formatPercent(t.arc.value.hitRatio)} hit`
              : ""
          }`}
        />
      )}
    </footer>
  );
}

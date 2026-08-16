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
 * Telemetry horizon (PLA-269): the four strongest ambient host signals form
 * one quiet strip. Lower-priority GPU, ARC, load and Docker detail lives in the
 * host/container drawers. Missing telemetry is explicit and never zero.
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
  className,
}: {
  label: string;
  value: string | null;
  status?: TelemetryDomain<unknown>["status"];
  spark?: React.ReactNode;
  title?: string;
  className?: string;
}) {
  const missing = value === null;
  return (
    <div
      className={`flex min-w-0 items-baseline gap-2 px-[clamp(0.65rem,1.2vw,1rem)] ${className ?? ""}`}
      title={title}
    >
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

  return (
    <footer
      aria-label="Live telemetry"
      className="grid shrink-0 grid-cols-2 border-t border-hairline sm:h-11 sm:grid-cols-4 sm:items-center"
    >
      <Cell
        className="border-r border-b border-hairline py-2 sm:border-b-0"
        label="cpu"
        status={t.cpu.status}
        value={
          t.cpu.value
            ? formatPercent(t.cpu.value.totalFraction)
            : null
        }
        spark={h ? <span className="max-[1100px]:hidden"><Spark points={h.cpuTotal} max={1} /></span> : undefined}
      />
      <Cell
        className="border-b border-hairline py-2 sm:border-r sm:border-b-0"
        label="mem"
        status={t.memory.status}
        value={
          t.memory.value
            ? `${formatBytes(t.memory.value.usedBytes, { system: "binary" })} / ${formatBytes(t.memory.value.totalBytes, { system: "binary", digits: 0 })}`
            : null
        }
      />
      <Cell
        className="border-r border-hairline py-2"
        label="net"
        status={t.network.status}
        value={
          t.network.value
            ? `↓ ${formatRate(t.network.value.rxBps)} ↑ ${formatRate(t.network.value.txBps)}`
            : null
        }
        spark={h ? <span className="max-[1100px]:hidden"><Spark points={h.netRx} /></span> : undefined}
      />
      <Cell
        className="py-2"
        label="disk"
        status={t.disk.status}
        value={
          t.disk.value
            ? `r ${formatRate(t.disk.value.readBps)} w ${formatRate(t.disk.value.writeBps)}`
            : null
        }
        spark={h ? <span className="max-[1100px]:hidden"><Spark points={h.diskWrite} /></span> : undefined}
      />
    </footer>
  );
}

"use client";

import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartFrame } from "@/components/charts/chart-frame";
import { ChartTooltip } from "@/components/charts/chart-tooltip";
import { token } from "@/lib/design/chart-colors";
import { formatRate } from "@/lib/utils";
import type { ThroughputPoint } from "@/lib/fake/series";

/**
 * Compact throughput area chart (PLA-176). Establishes "the acquisition system
 * is alive" at a glance. Restrained: no cartesian grid, a single sparse axis,
 * gentle enter animation, token-colored gradient fill. Empty data renders a
 * calm placeholder rather than an axis skeleton.
 */
function clock(t: number): string {
  return new Date(t).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ThroughputChart({
  data,
  height = 96,
  label = "Throughput",
}: {
  data: ThroughputPoint[];
  height?: number;
  label?: string;
}) {
  const hasData = data.some((d) => d.bps > 0);
  const range =
    data.length >= 2
      ? `${clock(data[0]!.t)}–${clock(data[data.length - 1]!.t)}`
      : undefined;

  return (
    <ChartFrame label={label} caption={hasData ? range : "no data"}>
      {!hasData ? (
        <EmptyPlot height={height} message="No transfer activity" />
      ) : (
        <div style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="tp-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={token("accent")} stopOpacity={0.5} />
                  <stop offset="100%" stopColor={token("accent")} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="t"
                tickFormatter={clock}
                tick={{ fontSize: 11, fill: token("faint") }}
                axisLine={false}
                tickLine={false}
                minTickGap={64}
                interval="preserveStartEnd"
              />
              <YAxis hide domain={[0, "dataMax"]} />
              <Tooltip
                content={
                  <ChartTooltip
                    format={(v) => formatRate(v)}
                    labelFormatter={(l) => clock(Number(l))}
                  />
                }
                cursor={{ stroke: token("hairline") }}
              />
              <Area
                type="monotone"
                dataKey="bps"
                name="Throughput"
                stroke={token("accent")}
                strokeWidth={2}
                fill="url(#tp-fill)"
                // Disable the initial reveal animation: under SSR/hydration
                // Recharts can leave its width-0 clip rect in place, hiding the
                // mark. Gentle interpolation on live data updates is handled
                // when real history is wired in (PLA-187/188).
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartFrame>
  );
}

export function EmptyPlot({
  height,
  message,
}: {
  height: number;
  message: string;
}) {
  return (
    <div
      style={{ height }}
      className="flex items-center justify-center rounded-md bg-surface/40 text-meta text-faint"
    >
      {message}
    </div>
  );
}

"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartFrame } from "@/components/charts/chart-frame";
import { ChartTooltip } from "@/components/charts/chart-tooltip";
import { EmptyPlot } from "@/components/charts/throughput-chart";
import { seriesColors, token } from "@/lib/design/chart-colors";
import { formatBytes } from "@/lib/utils";
import type { StorageTrendRow } from "@/lib/fake/series";

/**
 * Multi-series storage trend (PLA-176): used capacity per pool over a date
 * range. Series are distinguished by a token color AND a direct legend label
 * (never color alone). Restrained: one faint horizontal grid, a sparse date
 * axis, byte-formatted Y ticks so real units are visible.
 */
const SERIES_STROKES = seriesColors;

function day(t: number): string {
  return new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function StorageTrendChart({
  data,
  series,
  height = 160,
  label = "Used capacity",
}: {
  data: StorageTrendRow[];
  /** Pool names → keys present in each row. */
  series: string[];
  height?: number;
  label?: string;
}) {
  if (data.length === 0 || series.length === 0) {
    return (
      <ChartFrame label={label} caption="no data">
        <EmptyPlot height={height} message="No history yet" />
      </ChartFrame>
    );
  }

  const range = `${day(data[0]!.t)} – ${day(data[data.length - 1]!.t)}`;

  return (
    <ChartFrame label={label} caption={range}>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid
              vertical={false}
              stroke={token("hairline")}
              strokeOpacity={0.5}
            />
            <XAxis
              dataKey="t"
              tickFormatter={day}
              tick={{ fontSize: 11, fill: token("faint") }}
              axisLine={false}
              tickLine={false}
              minTickGap={48}
              interval="preserveStartEnd"
            />
            <YAxis
              tickFormatter={(v) => formatBytes(Number(v), 0)}
              tick={{ fontSize: 11, fill: token("faint") }}
              axisLine={false}
              tickLine={false}
              width={52}
            />
            <Tooltip
              content={
                <ChartTooltip
                  format={(v) => formatBytes(v)}
                  labelFormatter={(l) => day(Number(l))}
                />
              }
              cursor={{ stroke: token("hairline") }}
            />
            {series.map((name, i) => (
              <Line
                key={name}
                type="monotone"
                dataKey={name}
                name={name}
                stroke={SERIES_STROKES[i % SERIES_STROKES.length]}
                strokeWidth={2.25}
                dot={false}
                // See ThroughputChart: avoid the stuck width-0 reveal clip.
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {series.map((name, i) => (
          <li key={name} className="flex items-center gap-1.5 text-meta text-muted">
            <span
              aria-hidden
              className="h-0.5 w-3 rounded-full"
              style={{ background: SERIES_STROKES[i % SERIES_STROKES.length] }}
            />
            {name}
          </li>
        ))}
      </ul>
    </ChartFrame>
  );
}

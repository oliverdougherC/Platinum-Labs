import { ChartFrame } from "@/components/charts/chart-frame";
import { cn } from "@/lib/utils";
import type { EventBucket } from "@/lib/fake/series";

/**
 * Tiny health/event timeline strip (PLA-176). One cell per time bucket over the
 * window; height/opacity encodes event density and color encodes worst
 * severity. A per-cell title gives the hover tooltip and the bucket count is in
 * the accessible label, so meaning survives without color. Calm (all-idle) data
 * still renders as a quiet baseline, not an empty void.
 */
const SEVERITY_CLASS = {
  info: "bg-muted",
  warning: "bg-warn",
  critical: "bg-danger",
} as const;

function hour(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit" });
}

export function EventStrip({
  buckets,
  height = 40,
  label = "Activity — last 24h",
}: {
  buckets: EventBucket[];
  height?: number;
  label?: string;
}) {
  const max = Math.max(1, ...buckets.map((b) => b.count));

  return (
    <ChartFrame
      label={label}
      caption={
        buckets.length >= 2
          ? `${hour(buckets[0]!.t)}–${hour(buckets[buckets.length - 1]!.t)}`
          : undefined
      }
    >
      <div
        className="flex items-end gap-[3px]"
        style={{ height }}
        role="img"
        aria-label={`Event density over ${buckets.length} hours; ${buckets.reduce(
          (n, b) => n + b.count,
          0,
        )} events total`}
      >
        {buckets.map((b, i) => {
          const ratio = b.count / max;
          const barHeight = b.count === 0 ? 2 : 6 + ratio * (height - 6);
          return (
            <div
              key={i}
              title={`${hour(b.t)} · ${b.count} event${b.count === 1 ? "" : "s"}`}
              className="flex-1"
              style={{ height: barHeight }}
            >
              <div
                className={cn(
                  "h-full w-full rounded-[2px]",
                  b.count === 0
                    ? "bg-hairline"
                    : SEVERITY_CLASS[b.severity],
                )}
                style={{ opacity: b.count === 0 ? 1 : 0.4 + 0.6 * ratio }}
              />
            </div>
          );
        })}
      </div>
    </ChartFrame>
  );
}

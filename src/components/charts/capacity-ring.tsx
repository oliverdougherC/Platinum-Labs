import { capacityBand } from "@/lib/dashboard/derive";
import { token } from "@/lib/design/chart-colors";
import { cn, clamp, formatPercent } from "@/lib/utils";

/**
 * Current-capacity ring (PLA-176). A radial indicator that stays more legible
 * than a bar for a single "how full is this" number, with a direct center
 * label. Pure SVG (no chart lib). Tone follows the capacity band, and the band
 * word is available to assistive tech so status isn't color-only.
 */
const BAND_STROKE = {
  ok: token("accent"),
  warning: token("warn"),
  critical: token("danger"),
} as const;

const BAND_LABEL = {
  ok: "within normal range",
  warning: "near threshold",
  critical: "critically full",
} as const;

export function CapacityRing({
  fraction,
  size = 96,
  stroke = 8,
  label,
  warn = 0.8,
  critical = 0.9,
}: {
  fraction: number;
  size?: number;
  stroke?: number;
  label?: string;
  warn?: number;
  critical?: number;
}) {
  const f = clamp(fraction, 0, 1);
  const band = capacityBand(f, warn, critical);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = f * c;

  return (
    <div className="flex flex-col items-center gap-1">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`${label ? `${label} ` : ""}${formatPercent(f)} used, ${BAND_LABEL[band]}`}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={token("surface-2")}
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={BAND_STROKE[band]}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c - dash}`}
          strokeDashoffset={c / 4}
          className="transition-[stroke-dasharray] duration-500 ease-out"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text
          x="50%"
          y="50%"
          dominantBaseline="central"
          textAnchor="middle"
          className={cn("tnum fill-fg font-medium")}
          style={{ fontSize: size * 0.22 }}
        >
          {formatPercent(f)}
        </text>
      </svg>
      {label ? <span className="text-meta text-muted">{label}</span> : null}
    </div>
  );
}

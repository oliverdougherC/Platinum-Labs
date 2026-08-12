"use client";

/**
 * Shared Recharts tooltip (PLA-176). A restrained, token-styled surface with a
 * time header and one labelled row per series — the direct-label convention for
 * all charts. `format` renders each numeric value with real units.
 */
export interface ChartTooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: Array<{
    name?: string | number;
    value?: number;
    color?: string;
    dataKey?: string | number;
  }>;
  format?: (value: number) => string;
  labelFormatter?: (label: string | number) => string;
}

export function ChartTooltip({
  active,
  label,
  payload,
  format = (v) => String(v),
  labelFormatter,
}: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="rounded-md bg-surface-2/95 px-2.5 py-1.5 text-meta shadow-lg ring-1 ring-hairline backdrop-blur">
      {label !== undefined ? (
        <div className="mb-1 tnum text-faint">
          {labelFormatter ? labelFormatter(label) : label}
        </div>
      ) : null}
      <ul className="flex flex-col gap-0.5">
        {payload.map((row, i) => (
          <li key={i} className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-2 w-2 rounded-[2px]"
              style={{ background: row.color ?? "currentColor" }}
            />
            <span className="text-muted">{row.name}</span>
            <span className="tnum ml-auto text-fg">
              {format(row.value ?? 0)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

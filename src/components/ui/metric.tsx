import { cn } from "@/lib/utils";

/**
 * Metric — a primary numeric value with an optional unit and a label.
 *
 * Uses tabular numerals so changing values don't shift layout, and the
 * role-named `text-metric` size from the type scale. Label is `muted` (AA on
 * every surface); the value is primary `fg`.
 */
// Static map so Tailwind's JIT sees each literal class (no dynamic purging).
const TONE_CLASS = {
  fg: "text-fg",
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  accent: "text-accent",
} as const;

export function Metric({
  value,
  unit,
  label,
  className,
  tone = "fg",
}: {
  value: string | number;
  unit?: string;
  label?: string;
  className?: string;
  tone?: keyof typeof TONE_CLASS;
}) {
  const toneClass = TONE_CLASS[tone];
  return (
    <div className={cn("flex flex-col gap-0.5", className)}>
      <div className={cn("tnum text-metric font-medium leading-none", toneClass)}>
        {value}
        {unit ? (
          <span className="ml-1 text-body font-normal text-muted">{unit}</span>
        ) : null}
      </div>
      {label ? <div className="text-meta text-muted">{label}</div> : null}
    </div>
  );
}

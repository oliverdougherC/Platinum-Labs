import { cn, clamp } from "@/lib/utils";

/**
 * Minimal token-based progress bar. Width interpolates gently via CSS
 * transition so poll updates ease rather than jump (spec §4 data motion).
 * Accessible: exposes value semantics for assistive tech.
 */
const TONE_CLASS = {
  accent: "bg-accent",
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  muted: "bg-muted",
} as const;

export function ProgressBar({
  value,
  tone = "accent",
  className,
  label,
}: {
  /** 0..1 fraction. */
  value: number;
  tone?: keyof typeof TONE_CLASS;
  className?: string;
  label?: string;
}) {
  const pct = clamp(value, 0, 1) * 100;
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-label={label}
      className={cn(
        "h-1.5 w-full overflow-hidden rounded-full bg-surface-2",
        className,
      )}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-500 ease-out",
          TONE_CLASS[tone],
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

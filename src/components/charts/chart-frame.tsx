import { cn } from "@/lib/utils";

/**
 * ChartFrame (PLA-176) — a transparent wrapper that gives a chart an eyebrow
 * label and an optional right-aligned range/units caption, WITHOUT wrapping it
 * in another card. Charts are peers of the data around them, not nested boxes.
 */
export function ChartFrame({
  label,
  caption,
  children,
  className,
}: {
  label?: string;
  caption?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <figure className={cn("flex flex-col gap-1.5", className)}>
      {(label || caption) && (
        <figcaption className="flex items-baseline justify-between">
          {label ? <span className="eyebrow">{label}</span> : <span />}
          {caption ? (
            <span className="text-meta text-faint">{caption}</span>
          ) : null}
        </figcaption>
      )}
      {children}
    </figure>
  );
}

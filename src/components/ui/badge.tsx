import { cn } from "@/lib/utils";

/**
 * Small labelled badge for connector/state annotations (e.g. "stale",
 * "not configured"). Tone is conveyed by text + subtle tint, never color alone.
 */
const TONE_CLASS = {
  neutral: "text-muted ring-hairline",
  info: "text-accent ring-accent/40",
  ok: "text-ok ring-ok/40",
  warn: "text-warn ring-warn/40",
  danger: "text-danger ring-danger/40",
} as const;

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: keyof typeof TONE_CLASS;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-eyebrow uppercase tracking-[0.1em] ring-1",
        TONE_CLASS[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

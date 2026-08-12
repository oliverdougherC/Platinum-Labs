import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import type { VisualState } from "@/lib/design/tokens";

/**
 * Panel — the one surface primitive (PLA-173).
 *
 * The spec asks for "fewer boxes, stronger hierarchy": a Panel is a quiet
 * raised surface held by a faint ring rather than a heavy border, and its
 * accent responds to the ambient/active/attention visual state. Every module
 * uses this instead of ad-hoc `border`/`bg` classes so surfaces stay consistent.
 */
const stateRing: Record<VisualState, string> = {
  ambient: "ring-hairline/70",
  active: "ring-accent/40",
  attention: "ring-warn/50",
};

const stateGlow: Record<VisualState, string> = {
  ambient: "",
  active: "shadow-[0_0_0_1px_rgb(var(--color-accent)/0.10)]",
  attention: "shadow-[0_0_0_1px_rgb(var(--color-warn)/0.14)]",
};

export interface PanelProps extends HTMLAttributes<HTMLElement> {
  state?: VisualState;
}

export function Panel({
  state = "ambient",
  className,
  children,
  ...rest
}: PanelProps) {
  return (
    <section
      data-state={state}
      className={cn(
        "rounded-xl bg-surface/60 p-5 ring-1 transition-shadow duration-500",
        stateRing[state],
        stateGlow[state],
        className,
      )}
      {...rest}
    >
      {children}
    </section>
  );
}

/** Header row for a Panel: an eyebrow title plus optional trailing content. */
export function PanelHeader({
  title,
  id,
  trailing,
  className,
}: {
  title: string;
  id?: string;
  trailing?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-3 flex items-center justify-between", className)}>
      <h2 id={id} className="eyebrow">
        {title}
      </h2>
      {trailing}
    </div>
  );
}

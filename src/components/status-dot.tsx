import { cn } from "@/lib/utils";
import type { ConnectorStatus } from "@/lib/types";

/**
 * Status indicator that never relies on color alone (WCAG 1.4.1): the shape
 * carries a text label alongside the colored dot.
 */
const STATUS_META: Record<
  ConnectorStatus,
  { label: string; dot: string; text: string }
> = {
  healthy: { label: "Healthy", dot: "bg-ok", text: "text-ok" },
  degraded: { label: "Degraded", dot: "bg-warn", text: "text-warn" },
  unavailable: { label: "Unavailable", dot: "bg-danger", text: "text-danger" },
};

export function StatusDot({
  status,
  label,
}: {
  status: ConnectorStatus;
  label?: string;
}) {
  const meta = STATUS_META[status];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className={cn("h-2 w-2 rounded-full", meta.dot)}
      />
      <span className={cn("text-xs", meta.text)}>{label ?? meta.label}</span>
    </span>
  );
}

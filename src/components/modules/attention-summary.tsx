import { StatusDot } from "@/components/status-dot";
import { formatRelativeTime } from "@/lib/utils";
import type { AttentionItem, DashboardSnapshot } from "@/lib/types";

/**
 * System-attention summary (PLA-175) — answers "does anything need me?".
 *
 * Terse and reassuring when healthy; when there are alerts it lists them sorted
 * by severity, most urgent first. This is the prominent, greeting-level line
 * near the top of the page, not a boxed card.
 */
const SEVERITY_RANK: Record<AttentionItem["severity"], number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export function AttentionSummary({
  snapshot,
  now,
}: {
  snapshot: DashboardSnapshot;
  now: number;
}) {
  const items = [...snapshot.attention].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );

  return (
    <section aria-labelledby="attention-heading" className="max-w-3xl">
      <h2 id="attention-heading" className="sr-only">
        System attention
      </h2>
      {items.length === 0 ? (
        <p className="text-display font-medium tracking-tight text-fg">
          Everything looks good.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((a) => (
            <li key={a.ruleId} className="flex items-start gap-3">
              <span className="mt-1">
                <StatusDot
                  status={a.severity === "critical" ? "unavailable" : "degraded"}
                  label={a.severity === "critical" ? "Critical" : "Warning"}
                />
              </span>
              <span className="flex flex-col">
                <span className="text-title text-fg">{a.detail}</span>
                <span className="text-meta text-faint">
                  {a.source} · since {formatRelativeTime(a.firstSeenAt, now)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

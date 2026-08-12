import { StatusDot } from "@/components/status-dot";
import { interpretHealth } from "@/lib/dashboard/health-interpretation";
import { formatRelativeTime } from "@/lib/utils";
import type { DashboardSnapshot } from "@/lib/types";

/**
 * System-attention summary (PLA-175 / Phase 1.4) — answers "does anything need
 * me?".
 *
 * It never infers health from an empty alert list. `interpretHealth` positively
 * establishes healthy / incomplete / attention from real connector + pool
 * signals, so the reassuring line only appears when the system is actually,
 * verifiably fine. When evaluation is incomplete it says so calmly rather than
 * reassuring falsely or raising an alarm.
 */
export function AttentionSummary({
  snapshot,
  now,
}: {
  snapshot: DashboardSnapshot;
  now: number;
}) {
  const overall = interpretHealth(snapshot, now);

  return (
    <section aria-labelledby="attention-heading" className="max-w-3xl">
      <h2 id="attention-heading" className="sr-only">
        System attention
      </h2>
      {overall.kind === "healthy" ? (
        <p className="text-display font-medium tracking-tight text-fg">
          Everything looks good.
        </p>
      ) : overall.kind === "incomplete" ? (
        <div className="flex items-start gap-3">
          <span className="mt-1">
            <StatusDot status="degraded" label="Incomplete" />
          </span>
          <span className="flex flex-col">
            <span className="text-display font-medium tracking-tight text-fg">
              Status incomplete
            </span>
            <span className="text-meta text-faint">
              {overall.reasons.join(" · ")}
            </span>
          </span>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {overall.items.map((a) => (
            <li key={`${a.ruleId}:${a.source}:${a.subject ?? ""}`} className="flex items-start gap-3">
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

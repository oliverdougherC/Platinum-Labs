import { Panel, PanelHeader } from "@/components/ui/panel";
import { formatRelativeTime } from "@/lib/utils";
import { cn } from "@/lib/utils";
import type { ActivityEvent, DashboardSnapshot } from "@/lib/types";

/**
 * Recent activity (PLA-175) — a subordinate, quiet feed of normalized events.
 * "No activity" reads clearly as calm rather than broken.
 */
const SEVERITY_DOT: Record<ActivityEvent["severity"], string> = {
  info: "bg-muted",
  warning: "bg-warn",
  critical: "bg-danger",
};

export function ActivityFeed({
  snapshot,
  now,
  limit = 6,
}: {
  snapshot: DashboardSnapshot;
  now: number;
  limit?: number;
}) {
  const events = [...snapshot.activity]
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);

  return (
    <Panel className="flex flex-col">
      <PanelHeader title="Recent activity" id="activity-heading" />
      {events.length === 0 ? (
        <p className="text-meta text-faint">Nothing has happened recently.</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {events.map((ev) => (
            <li key={ev.id} className="flex items-baseline gap-2.5">
              <span
                aria-hidden
                className={cn(
                  "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                  SEVERITY_DOT[ev.severity],
                )}
              />
              <span className="flex-1 text-meta text-muted">{ev.message}</span>
              <span className="tnum shrink-0 text-meta text-faint">
                {formatRelativeTime(ev.at, now)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

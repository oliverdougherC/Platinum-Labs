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

// Non-color severity signal (never rely on the dot's colour alone).
const SEVERITY_LABEL: Record<ActivityEvent["severity"], string | null> = {
  info: null,
  warning: "Warning",
  critical: "Critical",
};

/** Exact local timestamp for the relative-time tooltip/affordance. */
function exactTime(at: number): string {
  return new Date(at).toLocaleString();
}

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

  // A failed persistence read collapses to [] but must NOT read as "nothing
  // happened" — the system genuinely does not know (PLA-194).
  const unknown = events.length === 0 && snapshot.activityAvailable === false;

  return (
    <Panel className="flex flex-col">
      <PanelHeader title="Recent activity" id="activity-heading" />
      {unknown ? (
        <p className="text-meta text-faint">Activity history is unavailable.</p>
      ) : events.length === 0 ? (
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
              {SEVERITY_LABEL[ev.severity] ? (
                <span className="sr-only">{SEVERITY_LABEL[ev.severity]}: </span>
              ) : null}
              <span className="flex-1 text-meta text-muted">{ev.message}</span>
              <time
                dateTime={new Date(ev.at).toISOString()}
                title={exactTime(ev.at)}
                className="tnum shrink-0 text-meta text-faint"
              >
                {formatRelativeTime(ev.at, now)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { DrawerShell } from "@/components/ui/overlay-shell";
import { BellIcon, OBSERVATORY_CONTROL_CLASS } from "@/components/ui/icons";
import {
  dismissGroup,
  groupNotifications,
  hasCritical,
  snoozeGroup,
  sourceLabel,
  toggleMuteRule,
  type NotificationGroup,
  type NotificationPrefs,
} from "@/lib/notifications/center";
import { loadPrefs, savePrefs } from "@/lib/notifications/persistence";
import { formatRelativeTime } from "@/lib/utils";
import type { AttentionItem, Severity } from "@/lib/types";

/**
 * Persistent notification center (PLA-268). At rest: one compact control in
 * the top chrome. Open: a right-side overlay with grouped alerts and
 * dismiss / snooze / mute actions persisted across refreshes (localStorage).
 * Alerts never reflow the topology; a critical alert additionally lights the
 * thin edge indicator rendered by the app shell.
 */

const SEVERITY_DOT: Record<Severity, string> = {
  critical: "bg-danger",
  warning: "bg-warn",
  info: "bg-accent",
};

function SnoozeMenu({ onSnooze }: { onSnooze: (ms: number) => void }) {
  return (
    <span className="flex items-center gap-1">
      {[
        ["1h", 60 * 60_000],
        ["8h", 8 * 60 * 60_000],
        ["24h", 24 * 60 * 60_000],
      ].map(([label, ms]) => (
        <button
          key={label as string}
          type="button"
          onClick={() => onSnooze(ms as number)}
          className="rounded px-1.5 py-0.5 text-[10.5px] text-faint ring-1 ring-hairline transition-colors hover:text-muted"
        >
          {label as string}
        </button>
      ))}
    </span>
  );
}

function GroupRow({
  group,
  now,
  muted,
  onDismiss,
  onSnooze,
  onToggleMute,
}: {
  group: NotificationGroup;
  now: number;
  muted: boolean;
  onDismiss: () => void;
  onSnooze: (ms: number) => void;
  onToggleMute: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="border-b border-hairline py-3 last:border-b-0">
      <div className="flex items-start gap-2.5">
        <span
          className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${SEVERITY_DOT[group.severity]}`}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className="block w-full text-left text-[13px] text-fg hover:text-fg"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
          >
            {group.title}
          </button>
          <p className="mt-0.5 text-[11px] text-faint">
            {sourceLabel(group.source)} · since{" "}
            {formatRelativeTime(group.firstSeenAt, now)}
            {group.items.length > 1 && ` · ${group.items.length} alerts`}
          </p>
          {expanded && (
            <ul className="mt-2 space-y-1.5">
              {group.items.map((item) => (
                <li key={item.alertId} className="text-[12px] text-muted">
                  {item.detail}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={onDismiss}
              className="rounded px-1.5 py-0.5 text-[10.5px] text-faint ring-1 ring-hairline transition-colors hover:text-muted"
            >
              Dismiss
            </button>
            <SnoozeMenu onSnooze={onSnooze} />
            <button
              type="button"
              onClick={onToggleMute}
              className="rounded px-1.5 py-0.5 text-[10.5px] text-faint ring-1 ring-hairline transition-colors hover:text-muted"
              title={`Mute all "${group.ruleId}" alerts`}
            >
              {muted ? "Unmute type" : "Mute type"}
            </button>
          </div>
        </div>
      </div>
    </li>
  );
}

/**
 * `now` is the app's authoritative clock (`referenceNow`): the frozen
 * snapshot clock under the review harness, wall time in production. Every
 * visible grouping/relative-time decision derives from it so frozen frames
 * are bit-identical regardless of the machine's system date (V2.1 review
 * blocker). Persistence WRITES still use real time outside frozen mode.
 */
export function useNotificationCenter(
  attention: AttentionItem[],
  frozen: boolean,
  now: number,
) {
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);

  // Load persisted prefs client-side once (SSR renders with none applied).
  // Snooze pruning is a persistence concern and may use real time.
  useEffect(() => {
    setPrefs(loadPrefs(Date.now()));
  }, []);

  const effectivePrefs = useMemo(
    () => prefs ?? { dismissed: {}, snoozed: {}, mutedRules: [], mutedSources: [] },
    [prefs],
  );

  const update = (next: NotificationPrefs) => {
    setPrefs(next);
    if (!frozen) savePrefs(next, Date.now());
  };

  const grouped = useMemo(
    () => groupNotifications(attention, effectivePrefs, now),
    [attention, effectivePrefs, now],
  );
  return {
    prefs: effectivePrefs,
    update,
    groups: grouped.groups,
    hiddenCount: grouped.hiddenCount,
    critical: hasCritical(attention, effectivePrefs, now),
  };
}

export function NotificationBell({
  count,
  critical,
  open,
  onToggle,
}: {
  count: number;
  critical: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`Notifications: ${count > 0 ? `${count} active${critical ? ", critical" : ""}` : "quiet"}`}
      title={`Notifications: ${count > 0 ? `${count} active` : "quiet"}`}
      className={`relative ${OBSERVATORY_CONTROL_CLASS}`}
    >
      <BellIcon />
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          critical ? "bg-danger" : count > 0 ? "bg-warn" : "bg-hairline"
        }`}
        aria-hidden
      />
      {count > 0 ? <span className="tnum">{count}</span> : null}
    </button>
  );
}

export function NotificationDrawer({
  open,
  groups,
  hiddenCount,
  prefs,
  now,
  onUpdatePrefs,
  onClose,
}: {
  open: boolean;
  groups: NotificationGroup[];
  hiddenCount: number;
  prefs: NotificationPrefs;
  /** Authoritative clock (frozen snapshot time under the review harness). */
  now: number;
  onUpdatePrefs: (next: NotificationPrefs) => void;
  onClose: () => void;
}) {
  return (
    <DrawerShell
      open={open}
      onClose={onClose}
      title="Notifications"
      closeLabel="Close notifications"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-5">
        {groups.length === 0 ? (
          <p className="py-8 text-[13px] text-faint">
            Nothing needs attention.
            {hiddenCount > 0 && ` ${hiddenCount} hidden by your preferences.`}
          </p>
        ) : (
          <ul>
            {groups.map((group) => (
              <GroupRow
                key={group.key}
                group={group}
                now={now}
                muted={prefs.mutedRules.includes(group.ruleId)}
                onDismiss={() => onUpdatePrefs(dismissGroup(prefs, group, now))}
                onSnooze={(ms) => onUpdatePrefs(snoozeGroup(prefs, group, now + ms))}
                onToggleMute={() => onUpdatePrefs(toggleMuteRule(prefs, group.ruleId))}
              />
            ))}
          </ul>
        )}
        {groups.length > 0 && hiddenCount > 0 && (
          <p className="border-t border-hairline py-3 text-[11px] text-faint">
            {hiddenCount} alert{hiddenCount === 1 ? "" : "s"} hidden by dismiss/snooze/mute.
          </p>
        )}
      </div>
    </DrawerShell>
  );
}

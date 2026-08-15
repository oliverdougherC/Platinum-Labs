"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

export function useNotificationCenter(attention: AttentionItem[], frozen: boolean) {
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);

  // Load persisted prefs client-side once (SSR renders with none applied).
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

  const now = Date.now();
  const grouped = useMemo(
    () => groupNotifications(attention, effectivePrefs, now),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `now` is a render-time clock read
    [attention, effectivePrefs],
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
      aria-label={`Notifications${count > 0 ? ` (${count} active)` : ""}`}
      className="relative flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] text-faint ring-1 ring-hairline transition-colors hover:text-muted"
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          critical ? "bg-danger" : count > 0 ? "bg-warn" : "bg-hairline"
        }`}
        aria-hidden
      />
      <span>{count > 0 ? `${count} alert${count === 1 ? "" : "s"}` : "quiet"}</span>
    </button>
  );
}

export function NotificationDrawer({
  open,
  groups,
  hiddenCount,
  prefs,
  onUpdatePrefs,
  onClose,
}: {
  open: boolean;
  groups: NotificationGroup[];
  hiddenCount: number;
  prefs: NotificationPrefs;
  onUpdatePrefs: (next: NotificationPrefs) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const now = Date.now();
  return (
    <aside
      ref={panelRef}
      aria-label="Notifications"
      aria-hidden={!open}
      className={`fixed right-0 top-0 z-40 flex h-full w-[360px] flex-col border-l border-hairline bg-surface/95 backdrop-blur-sm transition-transform duration-200 ${
        open ? "translate-x-0" : "translate-x-full"
      }`}
    >
      <header className="flex items-center justify-between border-b border-hairline px-5 py-4">
        <h2 className="text-[11px] uppercase tracking-[0.18em] text-faint">
          Notifications
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close notifications"
          className="text-[13px] text-faint transition-colors hover:text-muted"
        >
          ✕
        </button>
      </header>
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
    </aside>
  );
}

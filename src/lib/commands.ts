/**
 * Deterministic command palette logic (PLA-191).
 *
 * Pure and isomorphic — no LLM, no network. Every command operates on the
 * already-normalized `DashboardSnapshot` (never a live service call) and the
 * validated browser quick links. Unsupported input returns helpful suggestions
 * rather than failing.
 */

import { interpretHealth } from "@/lib/dashboard/health-interpretation";
import type { QuickLink } from "@/lib/quicklinks";
import type { DashboardSnapshot } from "@/lib/types";

export interface CommandContext {
  snapshot: DashboardSnapshot;
  links: QuickLink[];
  now: number;
}

export type CommandResult =
  | { kind: "navigate"; label: string; href: string }
  | { kind: "answer"; title: string; lines: string[] }
  | { kind: "suggestions"; message: string; suggestions: string[] };

const DAY = 86_400_000;

const QUERY_SUGGESTIONS = [
  "who is watching",
  "downloads",
  "storage",
  "issues",
  "what was added today",
];

/** Canonical suggestion list for the empty palette (opens + queries). */
export function suggestions(ctx: CommandContext): string[] {
  return [...ctx.links.map((l) => `open ${l.label.toLowerCase()}`), ...QUERY_SUGGESTIONS];
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/[?!.]+$/g, "").replace(/\s+/g, " ");
}

function findLink(ctx: CommandContext, name: string): QuickLink | undefined {
  const n = norm(name);
  return ctx.links.find((l) => norm(l.label) === n || norm(l.label).includes(n));
}

export function runCommand(input: string, ctx: CommandContext): CommandResult {
  const q = norm(input);
  if (!q) {
    return { kind: "suggestions", message: "Try one of these", suggestions: suggestions(ctx) };
  }

  // open <service> — or a bare service name that matches a quick link.
  const openMatch = q.match(/^(?:open|launch|go to)\s+(.+)$/);
  const linkName = openMatch ? openMatch[1]! : q;
  const link = findLink(ctx, linkName);
  if (link) {
    return { kind: "navigate", label: link.label, href: link.href };
  }
  // An explicit "open X" that matched no link is a graceful miss.
  if (openMatch) {
    return {
      kind: "suggestions",
      message: `No quick link named "${openMatch[1]}".`,
      suggestions: suggestions(ctx),
    };
  }

  if (/(who is watching|watching|jellyfin|sessions|playback)/.test(q)) {
    return whoIsWatching(ctx);
  }
  if (/(downloads?|queue|acquisition|transfers?)/.test(q)) {
    return downloads(ctx);
  }
  if (/(storage|pools?|disks?|capacity|zfs)/.test(q)) {
    return storage(ctx);
  }
  if (/(issues?|alerts?|attention|problems?|status)/.test(q)) {
    return issues(ctx);
  }
  if (/(added today|what was added|new today|imports? today|today)/.test(q)) {
    return addedToday(ctx);
  }

  return {
    kind: "suggestions",
    message: `No command matched "${input.trim()}".`,
    suggestions: suggestions(ctx),
  };
}

function whoIsWatching(ctx: CommandContext): CommandResult {
  const jf = ctx.snapshot.jellyfin;
  if (!jf.serverAvailable) {
    return { kind: "answer", title: "Who is watching", lines: ["Jellyfin is unreachable."] };
  }
  if (jf.sessions.length === 0) {
    return { kind: "answer", title: "Who is watching", lines: ["Nobody is watching right now."] };
  }
  return {
    kind: "answer",
    title: "Who is watching",
    lines: jf.sessions.map(
      (s) => `${s.user} — ${s.title}${s.subtitle ? ` (${s.subtitle})` : ""} · ${Math.round(s.progress * 100)}% · ${s.method}`,
    ),
  };
}

function downloads(ctx: CommandContext): CommandResult {
  const { items, rollup } = ctx.snapshot.acquisition;
  if (items.length === 0) {
    return { kind: "answer", title: "Downloads", lines: ["The acquisition queue is clear."] };
  }
  const head = `${rollup.downloading} downloading · ${rollup.importing} importing · ${rollup.failedOrStalled} stalled/failed`;
  return {
    kind: "answer",
    title: "Downloads",
    lines: [head, ...items.slice(0, 8).map((i) => `${i.title} — ${i.state} (${Math.round(i.progress * 100)}%)`)],
  };
}

function storage(ctx: CommandContext): CommandResult {
  const pools = ctx.snapshot.zfs.pools;
  if (pools.length === 0) {
    return { kind: "answer", title: "Storage", lines: ["No pools reporting."] };
  }
  return {
    kind: "answer",
    title: "Storage",
    lines: pools.map((p) => `${p.name} — ${Math.round(p.capacityFraction * 100)}% used · ${p.health}`),
  };
}

function issues(ctx: CommandContext): CommandResult {
  const overall = interpretHealth(ctx.snapshot, ctx.now);
  if (overall.kind === "healthy") {
    return { kind: "answer", title: "Issues", lines: ["Everything looks good."] };
  }
  if (overall.kind === "incomplete") {
    return { kind: "answer", title: "Issues", lines: ["Status incomplete:", ...overall.reasons] };
  }
  return {
    kind: "answer",
    title: "Issues",
    lines: overall.items.map((a) => `[${a.severity}] ${a.detail}`),
  };
}

function addedToday(ctx: CommandContext): CommandResult {
  const since = ctx.now - DAY;
  const added = ctx.snapshot.activity.filter(
    (e) => e.kind === "media.imported" && e.at >= since,
  );
  if (added.length === 0) {
    return { kind: "answer", title: "Added today", lines: ["Nothing has been added in the last 24 hours."] };
  }
  return {
    kind: "answer",
    title: "Added today",
    lines: added.map((e) => e.message),
  };
}

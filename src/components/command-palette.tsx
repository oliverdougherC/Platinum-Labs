"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { runCommand, suggestions, type CommandResult } from "@/lib/commands";
import { OverlayShell } from "@/components/ui/overlay-shell";
import { OBSERVATORY_CONTROL_CLASS, SearchIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import type { QuickLink } from "@/lib/quicklinks";
import type { DashboardSnapshot } from "@/lib/types";

/**
 * Deterministic command palette (PLA-191).
 *
 * Cmd/Ctrl+K opens it; Escape closes; ↑/↓ move; Enter runs the selected
 * suggestion (or the typed query). Every command is resolved by the pure
 * `runCommand` against the normalized snapshot + validated quick links — no LLM,
 * no direct service calls. A visually-subordinate enhancement: the dashboard is
 * fully usable without ever opening it.
 */
export function CommandPalette({
  snapshot,
  links,
  now,
  onMediaSearch,
  onOpen,
}: {
  snapshot: DashboardSnapshot;
  links: QuickLink[];
  now: number;
  /** Present when the Seerr media search surface is available (PLA-259). */
  onMediaSearch?: (query: string) => void;
  /** Lets the app close mutually-exclusive drawers before this modal opens. */
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [result, setResult] = useState<Exclude<
    CommandResult,
    { kind: "navigate" } | { kind: "media-search" }
  > | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const ctx = useMemo(
    () => ({ snapshot, links, now, mediaSearchEnabled: Boolean(onMediaSearch) }),
    [snapshot, links, now, onMediaSearch],
  );
  const allSuggestions = useMemo(() => suggestions(ctx), [ctx]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allSuggestions;
    return allSuggestions.filter((s) => s.includes(q));
  }, [allSuggestions, query]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setResult(null);
    setSelected(0);
  }, []);

  const openPalette = useCallback(() => {
    onOpen?.();
    setOpen(true);
  }, [onOpen]);

  const execute = useCallback(
    (input: string) => {
      const r = runCommand(input, ctx);
      if (r.kind === "navigate") {
        window.open(r.href, "_blank", "noopener,noreferrer");
        close();
        return;
      }
      if (r.kind === "media-search") {
        // Hand off to the media search overlay (runCommand only returns this
        // when the context reports the surface as enabled).
        close();
        onMediaSearch?.(r.query);
        return;
      }
      setResult(r);
    },
    [ctx, close, onMediaSearch],
  );

  // Global Cmd/Ctrl+K toggle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) close();
        else openPalette();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, open, openPalette]);

  // Keep the selection in range as the filtered list changes.
  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={openPalette}
        className={OBSERVATORY_CONTROL_CLASS}
        aria-keyshortcuts="Meta+K Control+K"
        aria-label="Search and commands"
        aria-haspopup="dialog"
        aria-expanded="false"
        title="Search and commands"
      >
        <SearchIcon />
        <span className="hidden 2xl:inline">Commands</span>
        <kbd className="tnum rounded bg-surface px-1.5 py-0.5 text-eyebrow text-muted">⌘K</kbd>
      </button>
    );
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, Math.max(0, filtered.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      execute(filtered[selected] ?? query);
    }
  };

  return (
    <OverlayShell
      open={open}
      onClose={close}
      label="Command palette"
      initialFocusRef={inputRef}
      panelClassName="mt-[3dvh]"
    >
      <div
        className="overflow-hidden"
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setResult(null);
          }}
          placeholder="Search services or ask: who is watching, downloads, storage, issues…"
          aria-label="Command input"
          className="w-full bg-transparent px-4 py-3 text-body text-fg outline-none placeholder:text-faint"
        />

        {result ? (
          <ResultView result={result} onPick={(s) => { setQuery(s); execute(s); }} />
        ) : (
          <ul className="max-h-72 overflow-y-auto border-t border-hairline py-1" role="listbox" aria-label="Commands">
            {filtered.length === 0 ? (
              <li className="px-4 py-2 text-meta text-faint">No matching commands.</li>
            ) : (
              filtered.map((s, i) => (
                <li key={s} role="option" aria-selected={i === selected}>
                  <button
                    type="button"
                    onMouseEnter={() => setSelected(i)}
                    onClick={() => execute(s)}
                    className={cn(
                      "block w-full px-4 py-2 text-left text-meta capitalize",
                      i === selected ? "bg-surface-2 text-fg" : "text-muted",
                    )}
                  >
                    {s}
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
      </div>
    </OverlayShell>
  );
}

// `navigate` is handled in `execute` and never reaches here.
type DisplayResult = Extract<CommandResult, { kind: "answer" | "suggestions" }>;

function ResultView({
  result,
  onPick,
}: {
  result: DisplayResult;
  onPick: (s: string) => void;
}) {
  if (result.kind === "answer") {
    return (
      <div className="border-t border-hairline px-4 py-3">
        <p className="mb-1 text-eyebrow uppercase tracking-[0.14em] text-faint">{result.title}</p>
        <ul className="flex flex-col gap-1">
          {result.lines.map((l, i) => (
            <li key={i} className="text-meta text-muted">{l}</li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="border-t border-hairline px-4 py-3">
      <p className="mb-2 text-meta text-faint">{result.message}</p>
      <ul className="flex flex-wrap gap-2">
        {result.suggestions.map((s) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => onPick(s)}
              className="rounded-lg px-2.5 py-1 text-meta capitalize text-muted ring-1 ring-hairline hover:text-fg"
            >
              {s}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

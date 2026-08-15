"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Badge } from "@/components/ui/badge";
import {
  posterProxyUrl,
  type SeerrMediaState,
  type SeerrRequestOutcome,
  type SeerrSearchResult,
} from "@/lib/seerr/api";
import { cn } from "@/lib/utils";

/**
 * Native media search + one-click request (PLA-259).
 *
 * A lightweight overlay over the ambient dashboard — the same interaction
 * grammar as the command palette (autofocus, ↑/↓ to move, Enter to act, Escape
 * to close) pointed at the normalized `/api/seerr/search` endpoint and the
 * `seerr.request` safe action. The browser never learns Seerr's API or URL.
 *
 * Success semantics are deliberately conservative: a row only shows `Approved`
 * after the backend has CONFIRMED the Seerr request is approved. It never
 * claims `Searching`/`Downloading` — downstream acquisition state belongs to
 * the existing Sonarr/Radarr/qBittorrent connectors when they observe it.
 */

const DEBOUNCE_MS = 300;
const MIN_QUERY_CHARS = 2;

type SearchPhase = "idle" | "loading" | "ok" | "error";

type RequestPhase =
  | { phase: "idle" }
  | { phase: "requesting" }
  | { phase: "settled"; state: SeerrMediaState | "approved" }
  | { phase: "failed"; message: string };

/** Truthful pre-existing state labels (never invented acquisition states). */
const STATE_BADGE: Record<
  SeerrMediaState | "approved",
  { label: string; tone: "neutral" | "ok" | "info" } | null
> = {
  requestable: null,
  pending: { label: "Pending approval", tone: "neutral" },
  processing: { label: "Processing", tone: "info" },
  partial: null, // partial TV keeps an explicit "Request missing" action
  available: { label: "Available", tone: "ok" },
  approved: { label: "Approved", tone: "ok" },
};

function keyOf(r: SeerrSearchResult): string {
  return `${r.mediaType}:${r.id}`;
}

/** Compact launcher rendered in the media panel header. */
export function MediaSearchLauncher({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-eyebrow uppercase tracking-[0.1em] text-faint ring-1 ring-hairline transition-colors hover:text-muted"
    >
      <span aria-hidden>⌕</span>
      <span>Request media</span>
    </button>
  );
}

export function MediaSearch({
  open,
  initialQuery = "",
  requestsEnabled,
  onClose,
}: {
  open: boolean;
  initialQuery?: string;
  /** When false, search works but no request controls are advertised. */
  requestsEnabled: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [phase, setPhase] = useState<SearchPhase>("idle");
  const [results, setResults] = useState<SeerrSearchResult[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [requests, setRequests] = useState<Record<string, RequestPhase>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  // Monotonic search generation. Bumped the instant the query changes, so a
  // response can only apply its results while its generation is still current —
  // an out-of-order response from a superseded query can never repopulate rows.
  const searchGenRef = useRef(0);

  // Sync the (possibly palette-seeded) query each time the overlay opens.
  useEffect(() => {
    if (open) {
      setQuery(initialQuery);
      setRequests({});
      setSelected(0);
      // Focus after the dialog mounts.
      const raf = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
  }, [open, initialQuery]);

  const runSearch = useCallback(async (q: string, gen: number) => {
    searchAbortRef.current?.abort();
    const ac = new AbortController();
    searchAbortRef.current = ac;
    try {
      const res = await fetch(`/api/seerr/search?q=${encodeURIComponent(q)}`, {
        signal: ac.signal,
        cache: "no-store",
      });
      const body = (await res.json().catch(() => null)) as
        | { results?: SeerrSearchResult[]; error?: string }
        | null;
      if (gen !== searchGenRef.current) return; // superseded by a newer query
      if (!res.ok || !body?.results) {
        setPhase("error");
        setSearchError(body?.error ?? "Search failed");
        return;
      }
      setResults(body.results);
      setSelected(0);
      setPhase("ok");
      setSearchError(null);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (gen !== searchGenRef.current) return;
      setPhase("error");
      setSearchError("Search failed");
    }
  }, []);

  // Debounced search; no query below the minimum length. The moment the query
  // changes, anything on screen belongs to a previous query: invalidate the
  // generation, abort the in-flight request, and clear the rows immediately so
  // a stale result can never be activated (Enter or click) while the
  // replacement search is debouncing or pending.
  useEffect(() => {
    if (!open) return;
    searchGenRef.current += 1;
    const gen = searchGenRef.current;
    searchAbortRef.current?.abort();
    setResults([]);
    setSelected(0);
    const q = query.trim();
    if (q.length < MIN_QUERY_CHARS) {
      setPhase("idle");
      setSearchError(null);
      return;
    }
    setPhase("loading");
    const timer = setTimeout(() => void runSearch(q, gen), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, query, runSearch]);

  useEffect(() => () => searchAbortRef.current?.abort(), []);

  const request = useCallback(
    async (result: SeerrSearchResult) => {
      const key = keyOf(result);
      // Guard against rapid double-activation client-side too (the backend
      // registry independently dedupes in-flight submissions).
      let alreadyInFlight = false;
      setRequests((prev) => {
        if (prev[key]?.phase === "requesting" || prev[key]?.phase === "settled") {
          alreadyInFlight = true;
          return prev;
        }
        return { ...prev, [key]: { phase: "requesting" } };
      });
      if (alreadyInFlight) return;

      let next: RequestPhase;
      try {
        const res = await fetch("/api/actions/seerr.request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mediaType: result.mediaType, mediaId: result.id }),
          cache: "no-store",
        });
        const outcome = (await res.json().catch(() => null)) as
          | SeerrRequestOutcome
          | { ok: false; message?: string }
          | null;
        if (outcome && outcome.ok === true) {
          next = {
            phase: "settled",
            state: outcome.outcome === "approved" ? "approved" : outcome.state,
          };
        } else {
          next = {
            phase: "failed",
            message:
              (outcome && "message" in outcome && outcome.message) ||
              "Request failed",
          };
        }
      } catch {
        next = { phase: "failed", message: "Request failed" };
      }
      setRequests((prev) => ({ ...prev, [key]: next }));
    },
    [],
  );

  const activate = useCallback(
    (result: SeerrSearchResult) => {
      if (!requestsEnabled) return;
      const status = requests[keyOf(result)] ?? { phase: "idle" };
      const actionable =
        (result.state === "requestable" || result.state === "partial") &&
        (status.phase === "idle" || status.phase === "failed");
      if (actionable) void request(result);
    },
    [requestsEnabled, requests, request],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, Math.max(0, results.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = results[selected];
      if (row) activate(row);
    }
  };

  const trimmed = query.trim();
  const showEmpty =
    phase === "ok" && results.length === 0 && trimmed.length >= MIN_QUERY_CHARS;

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Media search"
        className="w-full max-w-xl overflow-hidden rounded-xl bg-surface ring-1 ring-hairline"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 px-4">
          <span aria-hidden className="text-faint">⌕</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search movies & TV to request…"
            aria-label="Search movies and TV"
            className="w-full bg-transparent py-3 text-body text-fg outline-none placeholder:text-faint"
          />
          {phase === "loading" ? (
            <span className="shrink-0 text-eyebrow uppercase tracking-[0.1em] text-faint">
              searching…
            </span>
          ) : null}
        </div>

        <div className="max-h-[26rem] overflow-y-auto border-t border-hairline">
          {trimmed.length < MIN_QUERY_CHARS ? (
            <p className="px-4 py-6 text-center text-meta text-faint">
              Type at least two characters to search Seerr.
            </p>
          ) : phase === "error" ? (
            <div className="flex flex-col items-center gap-2 px-4 py-6">
              <p className="text-meta text-warn">{searchError}</p>
              <button
                type="button"
                onClick={() => void runSearch(trimmed, searchGenRef.current)}
                className="rounded-lg px-2.5 py-1 text-meta text-muted ring-1 ring-hairline hover:text-fg"
              >
                Retry
              </button>
            </div>
          ) : showEmpty ? (
            <p className="px-4 py-6 text-center text-meta text-faint">
              No movies or shows matched “{trimmed}”.
            </p>
          ) : (
            <ul
              role="listbox"
              aria-label="Search results"
              className={cn(
                "flex flex-col py-1 transition-opacity",
                phase === "loading" && "opacity-60",
              )}
            >
              {results.map((r, i) => (
                <ResultRow
                  key={keyOf(r)}
                  result={r}
                  selected={i === selected}
                  requestsEnabled={requestsEnabled}
                  status={requests[keyOf(r)] ?? { phase: "idle" }}
                  onSelect={() => setSelected(i)}
                  onRequest={() => activate(r)}
                />
              ))}
            </ul>
          )}
        </div>

        <p className="border-t border-hairline px-4 py-2 text-eyebrow uppercase tracking-[0.14em] text-faint">
          ↑↓ navigate · Enter to request · Esc to close
        </p>
      </div>
    </div>
  );
}

function ResultRow({
  result,
  selected,
  requestsEnabled,
  status,
  onSelect,
  onRequest,
}: {
  result: SeerrSearchResult;
  selected: boolean;
  requestsEnabled: boolean;
  status: RequestPhase;
  onSelect: () => void;
  onRequest: () => void;
}) {
  return (
    <li
      role="option"
      aria-selected={selected}
      onMouseEnter={onSelect}
      className={cn(
        "flex items-center gap-3 px-4 py-2.5",
        selected && "bg-panel",
      )}
    >
      <Poster result={result} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-body text-fg">
          {result.title}
          {result.year ? <span className="text-muted"> ({result.year})</span> : null}
        </p>
        <div className="mt-0.5 flex items-center gap-2">
          <Badge tone="neutral">{result.mediaType === "movie" ? "Movie" : "TV"}</Badge>
          {result.overview ? (
            <span className="truncate text-meta text-faint">{result.overview}</span>
          ) : null}
        </div>
        {status.phase === "failed" ? (
          <p className="mt-1 text-meta text-warn">{status.message}</p>
        ) : null}
      </div>
      <RowAction
        result={result}
        status={status}
        requestsEnabled={requestsEnabled}
        onRequest={onRequest}
      />
    </li>
  );
}

function RowAction({
  result,
  status,
  requestsEnabled,
  onRequest,
}: {
  result: SeerrSearchResult;
  status: RequestPhase;
  requestsEnabled: boolean;
  onRequest: () => void;
}) {
  if (status.phase === "requesting") {
    return (
      <span className="shrink-0 text-meta text-muted" aria-live="polite">
        Requesting…
      </span>
    );
  }
  if (status.phase === "settled") {
    const badge = STATE_BADGE[status.state];
    return badge ? (
      <Badge tone={badge.tone} className="shrink-0">
        {badge.label}
      </Badge>
    ) : null;
  }

  const badge = STATE_BADGE[result.state];
  if (badge) {
    return (
      <Badge tone={badge.tone} className="shrink-0">
        {badge.label}
      </Badge>
    );
  }

  // Requestable / partial TV. Never advertise the control when it is disabled.
  if (!requestsEnabled) return null;
  return (
    <button
      type="button"
      onClick={onRequest}
      className="shrink-0 rounded-lg px-2.5 py-1 text-meta text-fg ring-1 ring-accent/40 transition-colors hover:bg-accent/10"
    >
      {status.phase === "failed"
        ? "Retry"
        : result.state === "partial"
          ? "Request missing"
          : "Request"}
    </button>
  );
}

function Poster({ result }: { result: SeerrSearchResult }) {
  const [failed, setFailed] = useState(false);
  const letter = useMemo(() => result.title.charAt(0).toUpperCase(), [result.title]);

  if (!result.posterPath || failed) {
    return (
      <span
        aria-hidden
        className="flex h-[3.75rem] w-10 shrink-0 items-center justify-center rounded bg-panel text-title text-faint ring-1 ring-hairline"
      >
        {letter}
      </span>
    );
  }
  return (
    // Same-origin proxied artwork (see /api/seerr/poster); plain <img> keeps
    // next/image's optimizer out of the interactive path.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={posterProxyUrl(result.posterPath, "w92")}
      alt=""
      width={40}
      height={60}
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-[3.75rem] w-10 shrink-0 rounded object-cover ring-1 ring-hairline"
    />
  );
}

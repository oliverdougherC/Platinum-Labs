import { Panel, PanelHeader } from "@/components/ui/panel";
import { Metric } from "@/components/ui/metric";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ProgressBar } from "@/components/ui/progress-bar";
import { ThroughputChart } from "@/components/charts/throughput-chart";
import {
  acquisitionAvailability,
  connectorPresentation,
  healthById,
  mediaVisualState,
} from "@/lib/dashboard/derive";
import {
  cn,
  formatDuration,
  formatPercent,
  formatRate,
  formatRelativeTime,
} from "@/lib/utils";
import type {
  AcquisitionItem,
  DashboardSnapshot,
  JellyfinSession,
} from "@/lib/types";

/**
 * Media system — the dominant surface (PLA-175).
 *
 * Combines Jellyfin playback and the Sonarr/Radarr/qBittorrent acquisition
 * pipeline. Progressive disclosure: quiet when idle, detailed when watching or
 * downloading, elevated on attention. "Nobody is watching" (idle),
 * "Jellyfin unreachable" (data unavailable), and "not configured" are visually
 * distinct states.
 */
export function MediaModule({
  snapshot,
  now,
  searchSlot,
}: {
  snapshot: DashboardSnapshot;
  now: number;
  /** Optional Search / Request affordance (PLA-259), quiet in the header. */
  searchSlot?: React.ReactNode;
}) {
  const state = mediaVisualState(snapshot);
  const jf = healthById(snapshot.health, "jellyfin");
  const jfPresentation = connectorPresentation(jf, now);

  return (
    <Panel state={state} className="flex min-h-[19rem] flex-col lg:col-span-2">
      <PanelHeader
        title="Media"
        id="media-heading"
        trailing={
          <span className="flex items-center gap-2">
            {jfPresentation === "stale" ? <Badge tone="warn">stale</Badge> : null}
            {searchSlot}
          </span>
        }
      />

      <JellyfinBlock snapshot={snapshot} now={now} presentation={jfPresentation} />

      <Separator className="my-5" />

      <AcquisitionBlock snapshot={snapshot} now={now} />
    </Panel>
  );
}

function JellyfinBlock({
  snapshot,
  now,
  presentation,
}: {
  snapshot: DashboardSnapshot;
  now: number;
  presentation: ReturnType<typeof connectorPresentation>;
}) {
  const { jellyfin } = snapshot;

  if (presentation === "unconfigured") {
    return <p className="text-title text-faint">Jellyfin is not configured.</p>;
  }

  if (presentation === "unavailable" || !jellyfin.serverAvailable) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <p className="text-title text-warn">Jellyfin is unreachable.</p>
          <Badge tone="warn">offline</Badge>
        </div>
        <p className="text-meta text-muted">
          Showing last-known data for other services.
        </p>
      </div>
    );
  }

  if (jellyfin.sessions.length === 0) {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-title text-muted">Nobody is watching.</p>
        {jellyfin.lastPlaybackAt ? (
          <p className="text-meta text-faint">
            Last played {formatRelativeTime(jellyfin.lastPlaybackAt, now)}.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-4">
      {jellyfin.sessions.map((s) => (
        <SessionRow key={s.id} session={s} />
      ))}
    </ul>
  );
}

function SessionRow({ session }: { session: JellyfinSession }) {
  const isTranscode = session.method === "transcode";
  const methodLabel =
    session.method === "direct-play"
      ? "Direct play"
      : session.method === "direct-stream"
        ? "Direct stream"
        : "Transcoding";

  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-title">
          <span className="font-medium text-fg">{session.title}</span>
          {session.subtitle ? (
            <span className="text-muted"> — {session.subtitle}</span>
          ) : null}
        </p>
        <span className="shrink-0 text-meta text-muted">{session.user}</span>
      </div>
      <ProgressBar
        value={session.progress}
        tone={isTranscode ? "warn" : "accent"}
        label={`${session.title} progress`}
      />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-muted">
        <span className="tnum">{formatPercent(session.progress)}</span>
        <span aria-hidden>·</span>
        <Badge tone={isTranscode ? "warn" : "neutral"}>{methodLabel}</Badge>
        {session.resolution ? (
          <>
            <span aria-hidden>·</span>
            <span className="tnum">{session.resolution}</span>
          </>
        ) : null}
        {isTranscode && session.bitrateBps ? (
          <>
            <span aria-hidden>·</span>
            <span className="tnum">
              {(session.bitrateBps / 1_000_000).toFixed(1)} Mbps
            </span>
          </>
        ) : null}
      </div>
    </li>
  );
}

function AcquisitionBlock({
  snapshot,
  now,
}: {
  snapshot: DashboardSnapshot;
  now: number;
}) {
  const { items, rollup } = snapshot.acquisition;
  const top = items.slice(0, 4);

  // Real persisted throughput series (live) / deterministic series (fake). Only
  // revealed when there is actual transfer flow, so an idle system stays quiet
  // (no permanent empty chart placeholder).
  const throughput = snapshot.history?.throughput ?? [];
  const hasFlow = throughput.some((p) => p.bps > 0);

  // Truthful empty state: never claim the queue is "clear" when a source is
  // actually unavailable or unconfigured (PLA-194).
  const availability = acquisitionAvailability(snapshot, now);
  const emptyMessage =
    availability.kind === "unconfigured"
      ? "No download sources are configured."
      : availability.kind === "degraded"
        ? "Some download sources are unavailable — the queue may be incomplete."
        : availability.stale
          ? "Acquisition queue is clear (showing last-known-good)."
          : "Acquisition queue is clear.";

  return (
    <div className="mt-auto flex flex-col gap-4">
      <div className="flex flex-wrap gap-x-10 gap-y-4">
        <Metric value={rollup.downloading} label="downloading" />
        <Metric value={rollup.importing} label="importing" />
        <Metric
          value={rollup.failedOrStalled}
          label="stalled / failed"
          tone={rollup.failedOrStalled > 0 ? "warn" : "fg"}
        />
        <Metric value={formatRate(rollup.aggregateRateBps)} label="throughput" />
      </div>

      {hasFlow ? <ThroughputChart data={throughput} label="Transfer throughput" /> : null}

      {top.length === 0 ? (
        <p
          className={cn(
            "text-meta",
            availability.kind === "degraded" ? "text-warn" : "text-faint",
          )}
        >
          {emptyMessage}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-hairline">
          {top.map((item) => (
            <AcquisitionRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}

const STATE_TONE: Record<
  AcquisitionItem["state"],
  { tone: "accent" | "warn" | "danger" | "ok" | "muted"; label: string }
> = {
  searching: { tone: "muted", label: "Searching" },
  downloading: { tone: "accent", label: "Downloading" },
  importing: { tone: "ok", label: "Importing" },
  stalled: { tone: "warn", label: "Stalled" },
  failed: { tone: "danger", label: "Failed" },
  completed: { tone: "ok", label: "Completed" },
};

function AcquisitionRow({ item }: { item: AcquisitionItem }) {
  const meta = STATE_TONE[item.state];
  const badgeTone =
    meta.tone === "muted" || meta.tone === "accent" ? "neutral" : meta.tone;

  return (
    <li className="flex flex-col gap-1.5 py-2.5 first:pt-0 last:pb-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-body text-fg">{item.title}</span>
        <Badge tone={badgeTone}>{meta.label}</Badge>
      </div>
      <ProgressBar value={item.progress} tone={meta.tone} label={item.title} />
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-2 text-meta text-muted",
        )}
      >
        <span className="uppercase tracking-wide text-faint">{item.source}</span>
        {item.quality ? (
          <>
            <span aria-hidden>·</span>
            <span>{item.quality}</span>
          </>
        ) : null}
        <span aria-hidden>·</span>
        <span className="tnum">{formatPercent(item.progress)}</span>
        {item.rateBps && item.rateBps > 0 ? (
          <>
            <span aria-hidden>·</span>
            <span className="tnum">{formatRate(item.rateBps)}</span>
          </>
        ) : null}
        {item.etaSeconds != null ? (
          <>
            <span aria-hidden>·</span>
            <span className="tnum">ETA {formatDuration(item.etaSeconds)}</span>
          </>
        ) : null}
      </div>
    </li>
  );
}

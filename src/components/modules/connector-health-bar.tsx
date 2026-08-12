import { connectorPresentation } from "@/lib/dashboard/derive";
import { cn } from "@/lib/utils";
import type { ConnectorPresentation } from "@/lib/dashboard/derive";
import type { DashboardSnapshot } from "@/lib/types";

/**
 * Connector health strip (PLA-175). One compact chip per connector, presenting
 * ok / stale / unavailable / not-configured distinctly — status is conveyed by
 * both a dot and a word (never color alone).
 */
const PRESENTATION_META: Record<
  ConnectorPresentation,
  { dot: string; text: string; label: string }
> = {
  ok: { dot: "bg-ok", text: "text-muted", label: "healthy" },
  stale: { dot: "bg-warn", text: "text-warn", label: "stale" },
  unavailable: { dot: "bg-danger", text: "text-danger", label: "offline" },
  unconfigured: { dot: "bg-hairline", text: "text-faint", label: "not set up" },
  misconfigured: { dot: "bg-warn", text: "text-warn", label: "misconfigured" },
};

export function ConnectorHealthBar({
  snapshot,
  now,
}: {
  snapshot: DashboardSnapshot;
  now: number;
}) {
  return (
    <footer className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-hairline pt-4">
      {snapshot.health.map((c) => {
        const meta = PRESENTATION_META[connectorPresentation(c, now)];
        return (
          <span key={c.id} className="flex items-center gap-2">
            <span
              aria-hidden
              className={cn("h-2 w-2 rounded-full", meta.dot)}
            />
            <span className="text-meta capitalize text-muted">{c.id}</span>
            <span className={cn("text-meta", meta.text)}>{meta.label}</span>
          </span>
        );
      })}
    </footer>
  );
}

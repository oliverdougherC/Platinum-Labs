import { notFound } from "next/navigation";
import { shouldShowDevControls } from "@/lib/snapshot.server";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { ProgressBar } from "@/components/ui/progress-bar";
import { ThroughputChart } from "@/components/charts/throughput-chart";
import { StorageTrendChart } from "@/components/charts/storage-trend-chart";
import { CapacityRing } from "@/components/charts/capacity-ring";
import { EventStrip } from "@/components/charts/event-strip";
import { EmptyPlot } from "@/components/charts/throughput-chart";
import {
  eventBuckets,
  storageTrendSeries,
  throughputSeries,
  type ActivityLevel,
} from "@/lib/fake/series";

export const dynamic = "force-dynamic";

/**
 * Chart-language gallery (PLA-176).
 *
 * Demonstrates every visualization primitive in light-activity, high-activity,
 * and missing-data states. Dev-only: a normal production build 404s this route
 * (gated by `shouldShowDevControls()`), so the gallery never ships to users.
 *
 * A fixed `now` keeps every chart deterministic for stable screenshots/tests.
 */
const NOW = 1_754_000_000_000;
const TiB = 1024 ** 4;
const LEVELS: ActivityLevel[] = ["light", "high", "empty"];
const LEVEL_TITLE: Record<ActivityLevel, string> = {
  light: "Light activity",
  high: "High activity",
  empty: "Missing data",
};

export default function GalleryPage() {
  if (!shouldShowDevControls()) notFound();

  return (
    <main className="mx-auto flex max-w-canvas flex-col gap-10 px-6 py-8 md:px-10 lg:px-14">
      <header className="flex flex-col gap-1">
        <h1 className="text-display font-medium tracking-tight">
          Chart language gallery
        </h1>
        <p className="text-body text-muted">
          Every visualization primitive across light, high, and missing-data
          states. Dev-only — absent from production builds.
        </p>
      </header>

      <Section title="Throughput — compact time series">
        {LEVELS.map((level) => (
          <Panel key={level}>
            <PanelHeader title={LEVEL_TITLE[level]} />
            <ThroughputChart
              data={throughputSeries({ now: NOW, level })}
            />
          </Panel>
        ))}
      </Section>

      <Section title="Storage trend — multi-series">
        {LEVELS.map((level) => (
          <Panel key={level}>
            <PanelHeader title={LEVEL_TITLE[level]} />
            <StorageTrendChart
              series={["tank", "backup"]}
              data={storageTrendSeries({
                now: NOW,
                level,
                pools: [
                  { name: "tank", endBytes: 12.4 * TiB, totalBytes: 20 * TiB },
                  { name: "backup", endBytes: 3.1 * TiB, totalBytes: 8 * TiB },
                ],
              })}
            />
          </Panel>
        ))}
      </Section>

      <Section title="Capacity ring — radial indicator">
        <Panel>
          <PanelHeader title="Within range" />
          <div className="flex justify-center py-2">
            <CapacityRing fraction={0.62} label="tank" />
          </div>
        </Panel>
        <Panel>
          <PanelHeader title="Critically full" />
          <div className="flex justify-center py-2">
            <CapacityRing fraction={0.96} label="tank" />
          </div>
        </Panel>
        <Panel>
          <PanelHeader title="Missing data" />
          <div className="flex justify-center py-2">
            <EmptyPlot height={96} message="No capacity data" />
          </div>
        </Panel>
      </Section>

      <Section title="Event density — health strip">
        {LEVELS.map((level) => (
          <Panel key={level}>
            <PanelHeader title={LEVEL_TITLE[level]} />
            <EventStrip buckets={eventBuckets({ now: NOW, level })} />
          </Panel>
        ))}
      </Section>

      <Section title="Progress / throughput bar">
        <Panel>
          <PanelHeader title="Light" />
          <div className="flex flex-col gap-3 py-2">
            <ProgressBar value={0.18} tone="accent" label="download" />
            <ProgressBar value={0.63} tone="ok" label="import" />
          </div>
        </Panel>
        <Panel>
          <PanelHeader title="High / attention" />
          <div className="flex flex-col gap-3 py-2">
            <ProgressBar value={0.95} tone="warn" label="near full" />
            <ProgressBar value={0.04} tone="danger" label="failed" />
          </div>
        </Panel>
        <Panel>
          <PanelHeader title="Missing data" />
          <div className="flex flex-col gap-3 py-2">
            <ProgressBar value={0} tone="muted" label="no data" />
          </div>
        </Panel>
      </Section>
    </main>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-title font-medium text-fg">{title}</h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {children}
      </div>
    </section>
  );
}

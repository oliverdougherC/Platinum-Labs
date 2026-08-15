import {
  getDashboardSnapshot,
  getQuickLinks,
  resolveScenario,
  shouldShowDevControls,
} from "@/lib/snapshot.server";
import { getDataMode } from "@/lib/env.server";
import { getSeerrAvailability } from "@/lib/seerr/config.server";
import { LiveDashboard } from "@/components/live-dashboard";
import { ScenarioSwitcher } from "@/components/dev/scenario-switcher";
import { cn } from "@/lib/utils";

// Always render fresh: the dashboard is a live operational surface.
export const dynamic = "force-dynamic";

/**
 * Homepage (PLA-186).
 *
 * A thin server wrapper: it fetches the initial aggregate snapshot for a fast,
 * SSR first paint, then hands off to the client `LiveDashboard`, which polls the
 * `/api/dashboard` contract and updates in place. Composition, progressive
 * disclosure, and ambient motion come from earlier tickets.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ scenario?: string | string[] }>;
}) {
  const { scenario } = await searchParams;
  const initial = await getDashboardSnapshot({ scenarioOverride: scenario });

  const devControls = getDataMode() === "fake" && shouldShowDevControls();
  const currentScenario = resolveScenario(scenario);
  const scenarioParam = Array.isArray(scenario) ? scenario[0] : scenario;

  return (
    <main
      className={cn(
        "mx-auto flex min-h-screen max-w-canvas flex-col gap-8 px-6 py-8 md:gap-10 md:px-10 lg:px-14",
        devControls && "pb-20",
      )}
    >
      <LiveDashboard
        initial={initial}
        scenario={devControls ? scenarioParam : undefined}
        quickLinks={getQuickLinks()}
        seerr={getSeerrAvailability()}
      />
      {devControls ? <ScenarioSwitcher current={currentScenario} /> : null}
    </main>
  );
}

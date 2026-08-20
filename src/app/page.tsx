import {
  getDashboardSnapshot,
  getQuickLinks,
  resolveScenario,
  shouldShowDevControls,
} from "@/lib/snapshot.server";
import { getDataMode, getUiMode, type ServerEnv } from "@/lib/env.server";
import { getSeerrAvailability } from "@/lib/seerr/config.server";
import { ScenarioSwitcher } from "@/components/dev/scenario-switcher";
import { TopologyApp } from "@/components/topology/topology-app";

// Always render fresh: the dashboard is a live operational surface.
export const dynamic = "force-dynamic";

/**
 * V2 homepage (PLA-263): the Living Topology.
 *
 * A thin server wrapper — fetch the initial snapshot for SSR first paint, then
 * hand off to the client `TopologyApp` (SSE-driven). Dev-only query params
 * power the deterministic screenshot harness (PLA-270):
 *
 *   ?scenario=…            select a fake scenario (fake mode only)
 *   ?freeze=<epoch-ms>     render one deterministic frame, no transport/motion
 *   ?panel=notifications   open the notification drawer
 *   ?drawer=host|docker|pool:<name>|service:<id>   open a detail drawer
 *   ?transport=fallback|delayed|offline   deterministic shell state (dev only)
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const queryUiMode = one(params.ui);

  const devControls = shouldShowDevControls();
  const fake = getDataMode() === "fake";
  const configuredUiMode = getUiMode();
  const uiMode: ServerEnv["HOMELAB_UI_MODE"] =
    devControls && queryUiMode === "kinetic"
      ? queryUiMode
      : configuredUiMode;

  // Freeze is a dev/screenshot affordance: fake mode + dev controls only.
  const freezeRaw = devControls && fake ? Number(one(params.freeze)) : Number.NaN;
  const frozenAt = Number.isFinite(freezeRaw) && freezeRaw > 0 ? freezeRaw : null;

  const initial = await getDashboardSnapshot({
    scenarioOverride: params.scenario,
    nowOverride: frozenAt ?? undefined,
  });

  const currentScenario = resolveScenario(params.scenario);
  const scenarioParam = one(params.scenario);
  const panel = devControls && one(params.panel) === "notifications" ? "notifications" : null;
  const drawer = devControls ? one(params.drawer) ?? null : null;
  const transportParam = devControls ? one(params.transport) : undefined;
  const transportOverride =
    transportParam === "fallback"
      ? "reconnecting-with-fallback"
      : transportParam === "delayed"
        ? "data-delayed"
        : transportParam === "offline"
          ? "offline"
          : undefined;

  return (
    <>
      <TopologyApp
        initial={initial}
        seerr={getSeerrAvailability()}
        quickLinks={getQuickLinks()}
        uiMode={uiMode}
        scenario={fake && devControls ? scenarioParam : undefined}
        frozen={frozenAt !== null}
        initialPanels={{ panel, drawer }}
        transportOverride={transportOverride}
        devControls={fake && devControls}
      />
      {/* `switcher=off` keeps the dev control out of motion recordings. */}
      {devControls && fake && frozenAt === null && one(params.switcher) !== "off" ? (
        <ScenarioSwitcher current={currentScenario} />
      ) : null}
    </>
  );
}

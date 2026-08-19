import { notFound } from "next/navigation";
import { FabricCompositionStudy } from "@/components/dev/fabric-composition-study";
import { isScenario, type FakeScenario } from "@/lib/fake/snapshot";
import { shouldShowDevControls } from "@/lib/snapshot.server";

export const dynamic = "force-dynamic";

const DEFAULT_NOW = Date.UTC(2026, 7, 15, 12, 0, 0);

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Dev-only V3 composition study. This deliberately does not replace or mutate
 * the feature-flagged production FabricApp. It projects the existing
 * FabricModel into the promoted A+ synthesis against the sanitized 44-container
 * Docker fixture.
 */
export default async function FabricCompositionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!shouldShowDevControls()) notFound();
  const params = await searchParams;
  const scenarioRaw = one(params.scenario);
  const scenario: FakeScenario = isScenario(scenarioRaw) ? scenarioRaw : "container-mixed";
  const freezeRaw = Number(one(params.freeze));
  const now = Number.isFinite(freezeRaw) && freezeRaw > 0 ? freezeRaw : DEFAULT_NOW;
  const focus = one(params.focus) ?? (one(params.inspector) === "1" ? "group:platform" : null);
  const mode = one(params.mode) === "relationship-map" ? "relationship-map" : "activity";

  return (
    <div className="h-screen overflow-hidden">
      <FabricCompositionStudy
        initialScenario={scenario}
        initialViewMode={mode}
        now={now}
        initialFocus={focus}
      />
    </div>
  );
}

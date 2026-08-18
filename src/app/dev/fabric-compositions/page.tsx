import { notFound } from "next/navigation";
import { FabricCompositionStudy } from "@/components/dev/fabric-composition-study";
import { makeFakeSnapshot, isScenario, type FakeScenario } from "@/lib/fake/snapshot";
import { buildFabricComposition, type FabricCompositionId } from "@/lib/fabric/composition-study";
import { buildFabricModel } from "@/lib/fabric/model";
import { shouldShowDevControls } from "@/lib/snapshot.server";

export const dynamic = "force-dynamic";

const DEFAULT_NOW = Date.UTC(2026, 7, 15, 12, 0, 0);

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Dev-only V3 composition study. This deliberately does not replace or mutate
 * the feature-flagged production FabricApp. It projects the existing
 * FabricModel into three fixed study geometries against the sanitized
 * 44-container Docker fixture.
 */
export default async function FabricCompositionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!shouldShowDevControls()) notFound();
  const params = await searchParams;
  const studyRaw = one(params.study)?.toUpperCase();
  const study: FabricCompositionId = studyRaw === "B" || studyRaw === "C" ? studyRaw : "A";
  const scenarioRaw = one(params.scenario);
  const scenario: FakeScenario = isScenario(scenarioRaw) ? scenarioRaw : "container-mixed";
  const freezeRaw = Number(one(params.freeze));
  const now = Number.isFinite(freezeRaw) && freezeRaw > 0 ? freezeRaw : DEFAULT_NOW;

  const activitySnapshot = makeFakeSnapshot(scenario, now);
  const realScaleSnapshot = makeFakeSnapshot("container-field-real", now);
  const snapshot = {
    ...activitySnapshot,
    telemetry: {
      ...activitySnapshot.telemetry,
      docker: realScaleSnapshot.telemetry.docker,
    },
  };
  const model = buildFabricModel(snapshot, { now, seerrConfigured: true });
  const scene = buildFabricComposition(model, study);
  const focus = one(params.focus) ?? (one(params.inspector) === "1" ? model.population.groups[0]?.id ?? "jellyfin" : null);

  return (
    <FabricCompositionStudy
      scene={scene}
      model={model}
      quiet={scenario === "idle"}
      initialFocus={focus}
    />
  );
}

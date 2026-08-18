import { notFound } from "next/navigation";
import { FabricCompositionStudy } from "@/components/dev/fabric-composition-study";
import { isScenario, type FakeScenario } from "@/lib/fake/snapshot";
import type { FabricCompositionId } from "@/lib/fabric/composition-study";
import { shouldShowDevControls } from "@/lib/snapshot.server";

export const dynamic = "force-dynamic";

const DEFAULT_NOW = Date.UTC(2026, 7, 15, 12, 0, 0);

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Dev-only V3 composition study. This deliberately does not replace or mutate
 * the feature-flagged production FabricApp. It projects the existing
 * FabricModel into the three historical study geometries and the selected A+
 * synthesis against the sanitized 44-container Docker fixture.
 */
export default async function FabricCompositionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!shouldShowDevControls()) notFound();
  const params = await searchParams;
  const studyRaw = one(params.study)?.toUpperCase();
  const study: FabricCompositionId = studyRaw === "A+" || studyRaw === "B" || studyRaw === "C" ? studyRaw : "A";
  const scenarioRaw = one(params.scenario);
  const scenario: FakeScenario = isScenario(scenarioRaw) ? scenarioRaw : "container-mixed";
  const freezeRaw = Number(one(params.freeze));
  const now = Number.isFinite(freezeRaw) && freezeRaw > 0 ? freezeRaw : DEFAULT_NOW;
  const focus = one(params.focus) ?? (one(params.inspector) === "1" ? "group:platform" : null);

  return (
    <FabricCompositionStudy
      study={study}
      initialScenario={scenario}
      now={now}
      initialFocus={focus}
    />
  );
}

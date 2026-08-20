import { notFound } from "next/navigation";
import { KineticFlowLab } from "@/components/dev/kinetic-flow-lab";
import { isScenario, type FakeScenario } from "@/lib/fake/snapshot";
import { shouldShowDevControls } from "@/lib/snapshot.server";

export const dynamic = "force-dynamic";

const DEFAULT_NOW = Date.UTC(2026, 7, 15, 12, 0, 0);

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Dev-only V4 Kinetic Flow Canvas prototype. Consumes the deterministic fake
 * simulator (never handcrafted numbers) and renders the full kinetic surface
 * against any scenario. `?freeze=<epoch-ms>` pins both the data clock and the
 * animation phase for byte-identical screenshots; without it the lab ticks a
 * live clock so the scene breathes for motion capture.
 */
export default async function KineticFlowPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!shouldShowDevControls()) notFound();
  const params = await searchParams;
  const scenarioRaw = one(params.scenario);
  const scenario: FakeScenario = isScenario(scenarioRaw) ? scenarioRaw : "idle";
  const freezeRaw = Number(one(params.freeze));
  const frozen = Number.isFinite(freezeRaw) && freezeRaw > 0;
  const now = frozen ? freezeRaw : DEFAULT_NOW;

  return (
    <div className="h-screen overflow-hidden">
      <KineticFlowLab initialScenario={scenario} initialNow={now} frozen={frozen} />
    </div>
  );
}

import { notFound } from "next/navigation";
import { FlowLab } from "@/components/dev/flow-lab";
import { shouldShowDevControls } from "@/lib/snapshot.server";

/**
 * Flow design laboratory (PLA-266 v2 design study) — dev-only.
 *
 * Renders the EXACT production flow-drawing code against the eleven canonical
 * flow states (dormant → clamped → bidirectional → derived → state-only →
 * stale → unavailable) under alternative tunnel treatments, so the visual
 * decision is inspectable side by side. Gated exactly like the scenario
 * switcher: absent from a normal production build.
 *
 *   /dev/flow-lab?treatment=A|B|C   — pick a tunnel treatment
 *   &t=12                          — freeze the animation clock (contact sheet)
 */
export default async function FlowLabPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!shouldShowDevControls()) notFound();
  const params = await searchParams;
  const treatment = typeof params.treatment === "string" ? params.treatment : "A";
  const t = typeof params.t === "string" ? Number(params.t) : null;
  return <FlowLab treatment={treatment} fixedT={t} />;
}

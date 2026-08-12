import "server-only";

import { getDataMode } from "@/lib/env.server";
import {
  DEFAULT_SCENARIO,
  isScenario,
  makeFakeSnapshot,
  type FakeScenario,
} from "@/lib/fake/snapshot";
import type { DashboardSnapshot } from "@/lib/types";

/**
 * Server-side entry point for the normalized dashboard snapshot.
 *
 * - In `fake` mode (default) it returns deterministic simulator data. An
 *   optional `scenarioOverride` (from the dev switcher's query param) is honored
 *   only after validation and only in fake mode — untrusted input can never
 *   select anything but a known scenario, and never triggers a network call.
 * - In `live` mode it will aggregate the real connectors (Milestone 02,
 *   PLA-178/186). Until then it fails loudly so a misconfigured deploy can't
 *   silently serve empty data.
 *
 * This is the only module the app shell calls to obtain state.
 */
export async function getDashboardSnapshot(opts?: {
  scenarioOverride?: string | string[] | undefined;
}): Promise<DashboardSnapshot> {
  const mode = getDataMode();

  if (mode === "fake") {
    return makeFakeSnapshot(resolveScenario(opts?.scenarioOverride));
  }

  // Live mode: read the cached aggregate assembled by the connector registry
  // (PLA-186). Imported lazily so fake mode never loads the DB/connector stack.
  const { getLiveSnapshot } = await import("@/lib/dashboard/registry.server");
  return getLiveSnapshot();
}

/** Resolve the effective fake scenario: query override → env → default. */
export function resolveScenario(override?: string | string[]): FakeScenario {
  const candidate = Array.isArray(override) ? override[0] : override;
  if (isScenario(candidate)) return candidate;

  const fromEnv = process.env.HOMELAB_FAKE_SCENARIO;
  if (isScenario(fromEnv)) return fromEnv;

  return DEFAULT_SCENARIO;
}

/**
 * Whether dev-only controls (the scenario switcher) should render. Removed from
 * a normal production build; can be force-enabled for screenshots/e2e via
 * `HOMELAB_ENABLE_DEV_CONTROLS=1`.
 */
export function shouldShowDevControls(): boolean {
  return (
    process.env.NODE_ENV !== "production" ||
    process.env.HOMELAB_ENABLE_DEV_CONTROLS === "1"
  );
}

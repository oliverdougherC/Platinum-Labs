import Link from "next/link";
import {
  SCENARIOS,
  SCENARIO_LABELS,
  type FakeScenario,
} from "@/lib/fake/snapshot";
import { cn } from "@/lib/utils";

/**
 * Dev-only scenario switcher (PLA-177).
 *
 * Renders a compact, fixed control that lets a developer or UI test drive any
 * fixture scenario via the `?scenario=` query param — no source edits. The page
 * only mounts this when `shouldShowDevControls()` is true, so it is absent from
 * a normal production build.
 */
export function ScenarioSwitcher({ current }: { current: FakeScenario }) {
  return (
    <nav
      aria-label="Dev scenario switcher"
      className="fixed inset-x-0 bottom-0 z-50 flex justify-center pb-3"
    >
      <div className="flex max-w-[92vw] flex-wrap items-center gap-1 overflow-x-auto rounded-full bg-surface-2/90 px-2 py-1.5 ring-1 ring-hairline backdrop-blur">
        <span className="px-2 text-eyebrow uppercase tracking-[0.14em] text-faint">
          Scenario
        </span>
        {SCENARIOS.map((s) => (
          <Link
            key={s}
            href={{ query: { scenario: s } }}
            prefetch={false}
            aria-current={s === current ? "true" : undefined}
            title={SCENARIO_LABELS[s]}
            className={cn(
              "rounded-full px-2.5 py-1 text-meta transition-colors",
              s === current
                ? "bg-accent/20 text-fg ring-1 ring-accent/40"
                : "text-muted hover:bg-surface hover:text-fg",
            )}
          >
            {s}
          </Link>
        ))}
      </div>
    </nav>
  );
}

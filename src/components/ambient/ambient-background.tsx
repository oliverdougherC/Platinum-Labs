import { TimeOfDayTint } from "@/components/ambient/time-of-day-tint";

/**
 * Ambient background layer (PLA-174).
 *
 * Purely decorative and non-interactive (`aria-hidden`, `pointer-events-none`
 * via `.ambient-root`). Renders three slow blurred color fields, a faint grid,
 * subtle film grain, and time-of-day washes. All motion lives in CSS and only
 * animates transform/opacity; `TimeOfDayTint` is a tiny client component that
 * updates two CSS variables over the day.
 */
export function AmbientBackground() {
  return (
    <div className="ambient-root" aria-hidden="true" data-testid="ambient-root">
      <div className="ambient-orb ambient-orb--a" />
      <div className="ambient-orb ambient-orb--b" />
      <div className="ambient-orb ambient-orb--c" />
      <div className="ambient-grid" />
      <div className="ambient-noise" />
      <div className="ambient-warm" />
      <div className="ambient-dim" />
      <TimeOfDayTint />
    </div>
  );
}

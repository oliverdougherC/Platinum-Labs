"use client";

import { useEffect } from "react";
import { tintForHour } from "@/lib/design/ambient";

/**
 * Updates the ambient tint CSS variables based on the local hour.
 *
 * Renders nothing. Runs on the client only (so SSR keeps the neutral default
 * from `.ambient-root`, avoiding hydration mismatch) and refreshes every few
 * minutes so the wash tracks the day without a visible step.
 */
export function TimeOfDayTint() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>(".ambient-root");
    if (!root) return;

    const apply = () => {
      const { warm, dim } = tintForHour(new Date().getHours());
      root.style.setProperty("--ambient-warm", String(warm));
      root.style.setProperty("--ambient-dim", String(dim));
    };

    apply();
    const id = setInterval(apply, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  return null;
}

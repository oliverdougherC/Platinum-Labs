"use client";

/**
 * Dev harness around the V4 KineticCanvas: scenario selection via URL/state,
 * a live fake clock when not frozen, and the `window.__homelabSetScenario`
 * hook the motion-capture harness drives (scene changes without navigation).
 */

import { useEffect, useMemo, useState } from "react";
import { KineticCanvas } from "@/components/kinetic/kinetic-canvas";
import {
  isScenario,
  makeFakeSnapshot,
  type FakeScenario,
} from "@/lib/fake/snapshot";

const LIVE_TICK_MS = 2_000;

export function KineticFlowLab({
  initialScenario,
  initialNow,
  frozen,
}: {
  initialScenario: FakeScenario;
  initialNow: number;
  frozen: boolean;
}) {
  const [scenario, setScenario] = useState<FakeScenario>(initialScenario);
  const [now, setNow] = useState(initialNow);
  useEffect(() => setScenario(initialScenario), [initialScenario]);
  useEffect(() => setNow(initialNow), [initialNow]);

  // Live mode: advance the deterministic simulator clock so the scene
  // breathes; frozen mode never ticks.
  useEffect(() => {
    if (frozen) return;
    const timer = window.setInterval(() => setNow(Date.now()), LIVE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [frozen]);

  useEffect(() => {
    const devWindow = window as unknown as {
      __homelabSetScenario?: (next: string) => void;
    };
    devWindow.__homelabSetScenario = (next) => {
      if (isScenario(next)) setScenario(next);
    };
    return () => {
      delete devWindow.__homelabSetScenario;
    };
  }, []);

  const snapshot = useMemo(() => makeFakeSnapshot(scenario, now), [scenario, now]);

  return (
    <KineticCanvas
      snapshot={snapshot}
      now={now}
      seerrConfigured
      frozen={frozen}
      surfaceLabel="V4 kinetic flow canvas"
    />
  );
}

"use client";

/**
 * Dev harness around the V4 KineticCanvas: scenario selection via URL/state,
 * a live fake clock when not frozen, and the `window.__homelabSetScenario`
 * hook the motion-capture harness drives (scene changes without navigation).
 *
 * For the continuity-stress motion clip the harness can additionally scale
 * the qBittorrent transfer rates in place via `window.__homelabSetRateScale`:
 * the flow IDENTITY stays fixed while its magnitude moves through
 * low → medium → high → medium → low, which is exactly the case the phase-
 * continuity contract must survive. Dev-only capture affordance — the truth
 * pipeline itself is never touched. PLA-281 adds the equivalent deterministic
 * memory-scale hook for one stable container identity so the evidence harness
 * can record it taking area from its peers over successive samples.
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
  const [rateScale, setRateScale] = useState(1);
  const [containerMemoryScale, setContainerMemoryScale] = useState(1);
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
      __homelabSetRateScale?: (scale: number) => void;
      __homelabSetContainerMemoryScale?: (scale: number) => void;
    };
    devWindow.__homelabSetScenario = (next) => {
      if (isScenario(next)) setScenario(next);
    };
    devWindow.__homelabSetRateScale = (scale) => {
      if (Number.isFinite(scale) && scale >= 0 && scale <= 64) setRateScale(scale);
    };
    devWindow.__homelabSetContainerMemoryScale = (scale) => {
      if (Number.isFinite(scale) && scale >= 0.05 && scale <= 16) {
        setContainerMemoryScale(scale);
      }
    };
    return () => {
      delete devWindow.__homelabSetScenario;
      delete devWindow.__homelabSetRateScale;
      delete devWindow.__homelabSetContainerMemoryScale;
    };
  }, []);

  const snapshot = useMemo(() => {
    const base = makeFakeSnapshot(scenario, now);
    if (rateScale === 1 && containerMemoryScale === 1) return base;
    const scaled = structuredClone(base);
    const rollup = scaled.acquisition.rollup;
    if (rollup.aggregateRateBps !== null) {
      rollup.aggregateRateBps = Math.round(rollup.aggregateRateBps * rateScale);
    }
    if (rollup.uploadRateBps !== null && rollup.uploadRateBps !== undefined) {
      rollup.uploadRateBps = Math.round(rollup.uploadRateBps * rateScale);
    }
    const growing = scaled.telemetry.docker.value?.containers.find(
      (container) => container.name === "immich-machine-learning",
    );
    if (growing?.memoryBytes !== null && growing?.memoryBytes !== undefined) {
      growing.memoryBytes = Math.round(growing.memoryBytes * containerMemoryScale);
    }
    return scaled;
  }, [scenario, now, rateScale, containerMemoryScale]);

  return (
    <KineticCanvas
      snapshot={snapshot}
      now={now}
      seerrConfigured
      frozen={frozen}
      surfaceLabel="V4 kinetic flow canvas"
      debugHook
    />
  );
}

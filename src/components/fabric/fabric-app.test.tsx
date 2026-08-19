import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { FabricApp } from "@/components/fabric/fabric-app";
import { buildFabricModel } from "@/lib/fabric/model";
import * as fabricModel from "@/lib/fabric/model";
import * as compositionStudy from "@/lib/fabric/composition-study";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";

const NOW = Date.UTC(2026, 7, 15, 12);

beforeAll(() => {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: query.includes("reduce"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  window.history.pushState({}, "", "/");
});

describe("FabricApp", () => {
  it("samples rate-only live updates at the ambient cadence", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const buildModel = vi.spyOn(fabricModel, "buildFabricModel");
    const initial = makeFakeSnapshot("container-field-real", NOW);
    const rateUpdate = structuredClone(initial);
    rateUpdate.generatedAt += 2_000;
    rateUpdate.telemetry.cpu.value!.totalFraction = 0.91;

    const rendered = render(
      <FabricApp snapshot={initial} now={NOW} seerrConfigured frozen={false} reducedMotion={false} devControls={false} />,
    );
    expect(buildModel).toHaveBeenCalledTimes(1);

    rendered.rerender(
      <FabricApp snapshot={rateUpdate} now={NOW + 2_000} seerrConfigured frozen={false} reducedMotion={false} devControls={false} />,
    );
    expect(buildModel).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(9_999));
    expect(buildModel).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
    expect(buildModel).toHaveBeenCalledTimes(2);
  });

  it("promotes operational-story and frozen updates immediately", () => {
    const buildModel = vi.spyOn(fabricModel, "buildFabricModel");
    const idle = makeFakeSnapshot("idle", NOW);
    const active = makeFakeSnapshot("active", NOW + 2_000);
    const rendered = render(
      <FabricApp snapshot={idle} now={NOW} seerrConfigured frozen={false} reducedMotion={false} devControls={false} />,
    );
    expect(buildModel).toHaveBeenCalledTimes(1);

    rendered.rerender(
      <FabricApp snapshot={active} now={NOW + 2_000} seerrConfigured frozen={false} reducedMotion={false} devControls={false} />,
    );
    expect(buildModel).toHaveBeenCalledTimes(2);

    const frozenRateUpdate = structuredClone(active);
    frozenRateUpdate.telemetry.cpu.value!.totalFraction = 0.93;
    rendered.rerender(
      <FabricApp snapshot={frozenRateUpdate} now={NOW + 4_000} seerrConfigured frozen reducedMotion={false} devControls={false} />,
    );
    expect(buildModel).toHaveBeenCalledTimes(3);
  });

  it("suspends hidden promotion and resumes the latest snapshot on visibility", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const buildModel = vi.spyOn(fabricModel, "buildFabricModel");
    const initial = makeFakeSnapshot("container-field-real", NOW);
    const latest = structuredClone(initial);
    latest.generatedAt += 2_000;
    latest.telemetry.cpu.value!.totalFraction = 0.94;
    const rendered = render(
      <FabricApp snapshot={initial} now={NOW} seerrConfigured frozen={false} reducedMotion={false} devControls={false} />,
    );

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(rendered.container.querySelector("[data-fabric-mount]")).toHaveAttribute("data-motion", "off");
    rendered.rerender(
      <FabricApp snapshot={latest} now={NOW + 2_000} seerrConfigured frozen={false} reducedMotion={false} devControls={false} />,
    );
    act(() => vi.advanceTimersByTime(20_000));
    expect(buildModel).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(buildModel).toHaveBeenCalledTimes(2);
    const expectedCpuPrimary = buildFabricModel(latest, {
      now: NOW + 2_000,
      seerrConfigured: true,
    }).resourceViews.find((view) => view.id === "cpu")!.primary;
    expect(rendered.container.querySelector('[data-fabric-node="resource:cpu"]')).toHaveTextContent(expectedCpuPrimary);
  });

  it("reuses A+ geometry for runtime-only updates and invalidates it for exact topology changes", () => {
    const buildComposition = vi.spyOn(compositionStudy, "buildFabricComposition");
    const initial = makeFakeSnapshot("container-field-real", NOW);
    const runtimeUpdate = structuredClone(initial);
    runtimeUpdate.generatedAt += 2_000;
    runtimeUpdate.telemetry.cpu.value!.totalFraction = 0.91;
    runtimeUpdate.telemetry.docker.value!.containers[0]!.cpuFraction = 0.73;

    const rendered = render(
      <FabricApp
        snapshot={initial}
        now={NOW}
        seerrConfigured
        frozen
        reducedMotion={false}
        devControls={false}
      />,
    );
    expect(buildComposition).toHaveBeenCalledTimes(1);

    rendered.rerender(
      <FabricApp
        snapshot={runtimeUpdate}
        now={NOW + 2_000}
        seerrConfigured
        frozen
        reducedMotion={false}
        devControls={false}
      />,
    );
    expect(buildComposition).toHaveBeenCalledTimes(1);
    const expectedCpuPrimary = buildFabricModel(runtimeUpdate, {
      now: NOW + 2_000,
      seerrConfigured: true,
    }).resourceViews.find((view) => view.id === "cpu")!.primary;
    expect(rendered.container.querySelector('[data-fabric-node="resource:cpu"]')).toHaveTextContent(expectedCpuPrimary);

    const topologyUpdate = structuredClone(runtimeUpdate);
    topologyUpdate.telemetry.docker.value!.containers[0]!.networkNames = [
      ...(topologyUpdate.telemetry.docker.value!.containers[0]!.networkNames ?? []),
      "new-exact-segment",
    ];
    rendered.rerender(
      <FabricApp
        snapshot={topologyUpdate}
        now={NOW + 4_000}
        seerrConfigured
        frozen
        reducedMotion={false}
        devControls={false}
      />,
    );
    expect(buildComposition).toHaveBeenCalledTimes(2);
    buildComposition.mockRestore();
  });

  it("promotes the A+ composition and exposes both production and study diagnostics", () => {
    const { container } = render(
      <FabricApp
        snapshot={makeFakeSnapshot("container-field-real", NOW)}
        now={NOW}
        seerrConfigured
        frozen
        reducedMotion={false}
        devControls={false}
      />,
    );

    expect(container.querySelector('[data-study-id="A+"]')).not.toBeNull();
    expect(container.querySelector("[data-study-stage][data-fabric-stage]")).not.toBeNull();
    expect(container.querySelector('[data-study-node="service:jellyfin"][data-fabric-node="service:jellyfin"]')).not.toBeNull();
  });

  it("retains the last known Docker topology across stats loss but leaves a cold start incomplete", () => {
    const unavailable = makeFakeSnapshot("docker-unavailable", NOW + 1_000);
    const cold = render(
      <FabricApp
        snapshot={unavailable}
        now={NOW + 1_000}
        seerrConfigured
        frozen
        reducedMotion={false}
        devControls={false}
      />,
    );

    expect(cold.container.querySelector('[data-fabric-topology="incomplete"]')).not.toBeNull();
    expect(cold.container.querySelector('[data-fabric-node="group:platform"]')).toBeNull();
    cold.unmount();

    const rendered = render(
      <FabricApp
        snapshot={makeFakeSnapshot("container-field-real", NOW)}
        now={NOW}
        seerrConfigured
        frozen
        reducedMotion={false}
        devControls={false}
      />,
    );
    expect(rendered.container.querySelector('[data-fabric-node="group:platform"]')).not.toBeNull();

    rendered.rerender(
      <FabricApp
        snapshot={unavailable}
        now={NOW + 1_000}
        seerrConfigured
        frozen
        reducedMotion={false}
        devControls={false}
      />,
    );

    expect(rendered.container.querySelector('[data-fabric-topology="last-known"]')).not.toBeNull();
    expect(rendered.container.querySelector('[data-fabric-node="group:platform"]')).not.toBeNull();
  });

  it("honors the relationship-map query on the production renderer", () => {
    window.history.pushState({}, "", "/?relationships=1");
    const { container } = render(
      <FabricApp
        snapshot={makeFakeSnapshot("relationship-map", NOW)}
        now={NOW}
        seerrConfigured
        frozen
        reducedMotion={false}
        devControls={false}
      />,
    );

    expect(container.querySelector("[data-study-shell]")).toHaveAttribute("data-study-view-mode", "relationship-map");
    expect(container.querySelector('[data-study-logical-route^="declared:"][data-study-route-visible="true"]')).not.toBeNull();
  });

  it("keeps the healthy surface free of freshness chatter", () => {
    const { container } = render(
      <FabricApp
        snapshot={makeFakeSnapshot("idle", NOW)}
        now={NOW}
        seerrConfigured
        frozen={false}
        reducedMotion={false}
        devControls={false}
      />,
    );

    expect(screen.getByText("Server fabric")).toBeInTheDocument();
    expect(screen.queryByText(/updated|freshness|healthy|live/i)).not.toBeInTheDocument();
    expect(container.querySelector("[role='status']")).toBeNull();
    expect(container.querySelector("[data-fabric-route]")).toBeNull();
  });

  it("keeps focused routes scheduler-free across runtime motion modes", () => {
    const snapshot = makeFakeSnapshot("active", NOW);
    const { container, rerender } = render(
      <FabricApp
        snapshot={snapshot}
        now={NOW}
        seerrConfigured
        frozen={false}
        reducedMotion={false}
        devControls={false}
      />,
    );

    fireEvent.keyDown(container.querySelector('[data-fabric-node="service:jellyfin"]')!, { key: "Enter" });
    expect(container.querySelectorAll('[data-fabric-flow-motion="true"]')).toHaveLength(0);

    rerender(
      <FabricApp
        snapshot={snapshot}
        now={NOW}
        seerrConfigured
        frozen
        reducedMotion={false}
        devControls={false}
      />,
    );
    expect(container.querySelectorAll('[data-fabric-flow-motion="true"]')).toHaveLength(0);

    rerender(
      <FabricApp
        snapshot={snapshot}
        now={NOW}
        seerrConfigured
        frozen={false}
        reducedMotion
        devControls={false}
      />,
    );
    expect(container.querySelectorAll('[data-fabric-flow-motion="true"]')).toHaveLength(0);
  });

  it("opens the inspector from keyboard selection and clears it on Escape", () => {
    render(
      <FabricApp
        snapshot={makeFakeSnapshot("active", NOW)}
        now={NOW}
        seerrConfigured
        frozen
        reducedMotion={false}
        devControls={false}
      />,
    );

    const jellyfin = screen.getByRole("button", { name: /^Jellyfin;/ });
    jellyfin.focus();
    fireEvent.keyDown(jellyfin, { key: "Enter" });

    expect(screen.getByLabelText("Jellyfin inspector")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByLabelText("Jellyfin inspector")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(jellyfin);
  });

  it("supports Space activation for composition nodes", () => {
    render(
      <FabricApp
        snapshot={makeFakeSnapshot("active", NOW)}
        now={NOW}
        seerrConfigured
        frozen
        reducedMotion={false}
        devControls={false}
      />,
    );

    const sonarr = screen.getByRole("button", { name: /^Sonarr;/ });
    fireEvent.keyDown(sonarr, { key: " " });
    expect(screen.getByLabelText("Sonarr inspector")).toBeInTheDocument();
  });

  it("exposes the complete grouped workload population in technical details", () => {
    const snapshot = makeFakeSnapshot("container-field-real", NOW);
    const model = buildFabricModel(snapshot, { now: NOW, seerrConfigured: true });
    const group = model.population.groups[0]!;

    render(
      <FabricApp
        snapshot={snapshot}
        now={NOW}
        seerrConfigured
        frozen
        reducedMotion={false}
        devControls={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${group.label};`) }));
    fireEvent.click(screen.getByRole("button", { name: "Technical details" }));

    const dialog = screen.getByRole("dialog", { name: "Fabric technical details" });
    const populationHeading = within(dialog).getByText(
      `Complete workload population · ${group.members.length}`,
    );
    const list = populationHeading.parentElement?.querySelector("ul");

    expect(list).not.toBeNull();
    expect(within(list!).getAllByRole("listitem")).toHaveLength(group.members.length);
    expect(within(dialog).getByText(group.members[0]!.name)).toBeInTheDocument();
    expect(within(dialog).getByText(group.members.at(-1)!.name)).toBeInTheDocument();
  });
});

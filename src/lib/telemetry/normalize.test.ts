import { describe, expect, it } from "vitest";
import {
  cpuFractionFromJiffies,
  emptyTelemetry,
  gradeTelemetryFreshness,
  hostCollectorSchema,
  normalizeHostTelemetry,
  notConfiguredTelemetry,
  type RawHostSample,
} from "@/lib/telemetry/normalize";

function jiffies(busy: number, idle: number): number[] {
  // [user, nice, system, idle, iowait, irq, softirq, steal]
  return [busy, 0, 0, idle, 0, 0, 0, 0];
}

function sample(at: number, overrides: Partial<RawHostSample> = {}): RawHostSample {
  return hostCollectorSchema.parse({
    sampledAt: at,
    cpu: {
      status: "ok",
      total: jiffies(1000, 3000),
      cores: [jiffies(500, 1500), jiffies(500, 1500)],
      load: [1.5, 1.2, 1.0],
    },
    memory: {
      status: "ok",
      totalBytes: 135_050_678_272,
      availableBytes: 81_880_268_800,
      swapTotalBytes: 68_719_472_640,
      swapUsedBytes: 258_473_984,
    },
    network: {
      status: "ok",
      interfaces: { eno1: { rxBytes: 1_000_000, txBytes: 500_000 } },
    },
    disk: {
      status: "ok",
      devices: {
        sda: { readBytes: 10_000_000, writeBytes: 5_000_000 },
        nvme0n1: { readBytes: 2_000_000, writeBytes: 1_000_000 },
      },
      poolDevices: { DataStore: ["sda"], NVME: ["nvme0n1"] },
    },
    gpu: {
      status: "ok",
      name: "NVIDIA GeForce GTX 1070",
      utilizationPercent: 12,
      vramUsedBytes: 2_097_152,
      vramTotalBytes: 8_589_934_592,
      temperatureC: 46,
      powerWatts: 11.8,
    },
    docker: {
      status: "ok",
      containers: [
        {
          name: "jellyfin",
          state: "running",
          health: "healthy",
          restartCount: 0,
          cpuTotalNs: 1_000_000_000,
          systemCpuNs: 100_000_000_000,
          memoryBytes: 500_000_000,
        },
        {
          name: "broken",
          state: "exited",
          health: null,
          restartCount: 3,
          cpuTotalNs: null,
          systemCpuNs: null,
          memoryBytes: null,
        },
      ],
    },
    arc: {
      status: "ok",
      sizeBytes: 40_000_000_000,
      targetBytes: 60_000_000_000,
      hits: 900,
      misses: 100,
    },
    ...overrides,
  });
}

function advance(at: number): RawHostSample {
  return sample(at, {
    cpu: {
      status: "ok",
      // +500 busy, +500 idle → 50% total
      total: jiffies(1500, 3500),
      // core 0: +400 busy +100 idle = 80%; core 1: +100 busy +400 idle = 20%
      cores: [jiffies(900, 1600), jiffies(600, 1900)],
      load: [2.0, 1.5, 1.1],
    },
    network: {
      status: "ok",
      // +2 MB rx, +1 MB tx over 2 s → 1 MB/s and 0.5 MB/s
      interfaces: { eno1: { rxBytes: 3_000_000, txBytes: 1_500_000 } },
    },
    disk: {
      status: "ok",
      devices: {
        sda: { readBytes: 30_000_000, writeBytes: 9_000_000 },
        nvme0n1: { readBytes: 2_000_000, writeBytes: 3_000_000 },
      },
      poolDevices: { DataStore: ["sda"], NVME: ["nvme0n1"] },
    },
    docker: {
      status: "ok",
      containers: [
        {
          name: "jellyfin",
          state: "running",
          health: "healthy",
          restartCount: 0,
          // +2e9 container ns over +200e9 system ns on 2 cores = 0.02 cores
          cpuTotalNs: 3_000_000_000,
          systemCpuNs: 300_000_000_000,
          memoryBytes: 600_000_000,
        },
        {
          name: "broken",
          state: "exited",
          health: null,
          restartCount: 3,
          cpuTotalNs: null,
          systemCpuNs: null,
          memoryBytes: null,
        },
      ],
    },
  });
}

describe("normalizeHostTelemetry", () => {
  it("reports rate domains unavailable on the first sample instead of zero", () => {
    const snap = normalizeHostTelemetry(null, sample(1000));
    expect(snap.cpu.status).toBe("unavailable");
    expect(snap.cpu.value).toBeNull();
    expect(snap.network.status).toBe("unavailable");
    expect(snap.disk.status).toBe("unavailable");
    // Instantaneous domains are available immediately.
    expect(snap.memory.status).toBe("available");
    expect(snap.gpu.status).toBe("available");
    expect(snap.arc.status).toBe("available");
  });

  it("computes per-core and total CPU utilization from jiffy deltas", () => {
    const first = sample(1000);
    const snap = normalizeHostTelemetry(first, advance(3000));
    expect(snap.cpu.status).toBe("available");
    expect(snap.cpu.value!.totalFraction).toBeCloseTo(0.5, 5);
    expect(snap.cpu.value!.perCore).toHaveLength(2);
    expect(snap.cpu.value!.perCore[0]).toBeCloseTo(0.8, 5);
    expect(snap.cpu.value!.perCore[1]).toBeCloseTo(0.2, 5);
    expect(snap.cpu.value!.load1).toBe(2.0);
  });

  it("computes network and per-pool disk rates", () => {
    const snap = normalizeHostTelemetry(sample(1000), advance(3000));
    expect(snap.network.value!.rxBps).toBeCloseTo(1_000_000, 3);
    expect(snap.network.value!.txBps).toBeCloseTo(500_000, 3);
    expect(snap.disk.value!.readBps).toBeCloseTo(10_000_000, 3);
    expect(snap.disk.value!.writeBps).toBeCloseTo(3_000_000, 3);
    const pools = Object.fromEntries(
      snap.disk.value!.pools.map((p) => [p.pool, p]),
    );
    expect(pools.DataStore!.readBps).toBeCloseTo(10_000_000, 3);
    expect(pools.NVME!.writeBps).toBeCloseTo(1_000_000, 3);
  });

  it("holds last-known-good as stale on a counter reset instead of faking zero", () => {
    const first = sample(1000);
    const second = advance(3000);
    const good = normalizeHostTelemetry(first, second);
    // Counters go backwards (reboot).
    const reset = sample(5000, {
      network: {
        status: "ok",
        interfaces: { eno1: { rxBytes: 10, txBytes: 5 } },
      },
    });
    const snap = normalizeHostTelemetry(second, reset, good);
    expect(snap.network.status).toBe("stale");
    expect(snap.network.value!.rxBps).toBeCloseTo(1_000_000, 3);
  });

  it("maps collector section failures to unavailable, not zeros", () => {
    const broken = sample(3000, {
      cpu: { status: "unavailable" },
      memory: { status: "unavailable" },
      network: { status: "unavailable" },
    } as Partial<RawHostSample>);
    const snap = normalizeHostTelemetry(sample(1000), broken);
    expect(snap.cpu.status).toBe("unavailable");
    expect(snap.memory.status).toBe("unavailable");
    expect(snap.memory.value).toBeNull();
  });

  it("distinguishes not-configured GPU and Docker from unavailable", () => {
    const none = sample(3000, {
      gpu: { status: "not-configured" },
      docker: { status: "not-configured" },
    } as Partial<RawHostSample>);
    const snap = normalizeHostTelemetry(sample(1000), none);
    expect(snap.gpu.status).toBe("not-configured");
    expect(snap.docker.status).toBe("not-configured");
  });

  it("normalizes docker containers with per-container cpu cores and counts", () => {
    const snap = normalizeHostTelemetry(sample(1000), advance(3000));
    expect(snap.docker.status).toBe("available");
    const docker = snap.docker.value!;
    expect(docker.total).toBe(2);
    expect(docker.running).toBe(1);
    expect(docker.healthy).toBe(1);
    expect(docker.unhealthy).toBe(0);
    const jellyfin = docker.containers.find((c) => c.name === "jellyfin")!;
    expect(jellyfin.cpuFraction).toBeCloseTo(0.02, 5);
    expect(jellyfin.memoryBytes).toBe(600_000_000);
    const broken = docker.containers.find((c) => c.name === "broken")!;
    expect(broken.cpuFraction).toBeNull();
    expect(broken.state).toBe("exited");
  });

  it("keeps unknown restart counts null instead of fabricating 0 (PLA-273)", () => {
    const withUnknownRestarts = (at: number) =>
      sample(at, {
        docker: {
          status: "ok",
          containers: [
            {
              name: "jellyfin",
              state: "running",
              health: "healthy",
              // /containers/json does not know restart counts.
              restartCount: null,
              cpuTotalNs: null,
              systemCpuNs: null,
              memoryBytes: null,
            },
          ],
        },
      } as Partial<RawHostSample>);
    const snap = normalizeHostTelemetry(withUnknownRestarts(1000), withUnknownRestarts(3000));
    expect(snap.docker.value!.containers[0]!.restartCount).toBeNull();
  });

  it("keeps missing load averages null instead of fabricating 0.00 (PLA-273)", () => {
    const noLoad = (at: number, cpu: object) =>
      sample(at, { cpu: { status: "ok", ...cpu } } as Partial<RawHostSample>);
    const base = {
      total: jiffies(1000, 3000),
      cores: [jiffies(500, 1500), jiffies(500, 1500)],
    };
    const next = {
      total: jiffies(1500, 3500),
      cores: [jiffies(900, 1600), jiffies(600, 1900)],
    };
    // Entirely missing tuple → all null; CPU utilization still computed.
    const missing = normalizeHostTelemetry(
      noLoad(1000, { ...base, load: null }),
      noLoad(3000, { ...next, load: null }),
    );
    expect(missing.cpu.status).toBe("available");
    expect(missing.cpu.value!.totalFraction).toBeCloseTo(0.5, 5);
    expect(missing.cpu.value!.load1).toBeNull();
    expect(missing.cpu.value!.load15).toBeNull();
    // Truncated tuple → missing elements null, present ones kept.
    const truncated = normalizeHostTelemetry(
      noLoad(1000, { ...base, load: [1.5] }),
      noLoad(3000, { ...next, load: [2.0] }),
    );
    expect(truncated.cpu.value!.load1).toBe(2.0);
    expect(truncated.cpu.value!.load5).toBeNull();
  });

  it("keeps unreported swap null instead of claiming a swapless host (PLA-273)", () => {
    const noSwap = sample(1000, {
      memory: {
        status: "ok",
        totalBytes: 1000,
        availableBytes: 400,
        swapTotalBytes: null,
        swapUsedBytes: null,
      },
    } as Partial<RawHostSample>);
    const snap = normalizeHostTelemetry(null, noSwap);
    expect(snap.memory.value!.swapTotalBytes).toBeNull();
    expect(snap.memory.value!.swapUsedBytes).toBeNull();
  });

  it("keeps a missing ARC target null instead of echoing size (PLA-273)", () => {
    const noTarget = sample(1000, {
      arc: { status: "ok", sizeBytes: 42, targetBytes: null, hits: null, misses: null },
    } as Partial<RawHostSample>);
    const snap = normalizeHostTelemetry(null, noTarget);
    expect(snap.arc.value!.sizeBytes).toBe(42);
    expect(snap.arc.value!.targetBytes).toBeNull();
    expect(snap.arc.value!.hitRatio).toBeNull();
  });

  it("computes memory used from total - available and ARC hit ratio", () => {
    const snap = normalizeHostTelemetry(null, sample(1000));
    expect(snap.memory.value!.usedBytes).toBe(135_050_678_272 - 81_880_268_800);
    expect(snap.arc.value!.hitRatio).toBeCloseTo(0.9, 5);
  });
});

describe("freshness grading", () => {
  it("marks aged available domains stale but keeps the value", () => {
    const snap = normalizeHostTelemetry(sample(1000), advance(3000));
    const graded = gradeTelemetryFreshness(snap, 3000 + 10_000, 6_000);
    expect(graded.cpu.status).toBe("stale");
    expect(graded.cpu.value!.totalFraction).toBeCloseTo(0.5, 5);
    const fresh = gradeTelemetryFreshness(snap, 3000 + 1_000, 6_000);
    expect(fresh.cpu.status).toBe("available");
  });
});

describe("cpuFractionFromJiffies", () => {
  it("returns null for a zero or negative window", () => {
    expect(cpuFractionFromJiffies(jiffies(10, 10), jiffies(10, 10))).toBeNull();
    expect(cpuFractionFromJiffies(jiffies(20, 20), jiffies(10, 10))).toBeNull();
  });
});

describe("empty snapshots", () => {
  it("has every domain unavailable / not-configured with null values", () => {
    for (const domain of Object.values(emptyTelemetry())) {
      expect(domain.status).toBe("unavailable");
      expect(domain.value).toBeNull();
    }
    for (const domain of Object.values(notConfiguredTelemetry())) {
      expect(domain.status).toBe("not-configured");
    }
  });
});

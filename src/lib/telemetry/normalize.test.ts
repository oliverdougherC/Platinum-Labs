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
      sampledAt: at,
      name: "NVIDIA GeForce GTX 1070",
      utilizationPercent: 12,
      vramUsedBytes: 2_097_152,
      vramTotalBytes: 8_589_934_592,
      temperatureC: 46,
      powerWatts: 11.8,
    },
    docker: {
      status: "ok",
      sampledAt: at,
      containers: [
        {
          name: "jellyfin",
          state: "running",
          health: "healthy",
          stableId: "ctr-107f331d4217e3f4",
          composeProject: "media-stack",
          composeService: "jellyfin",
          networkNames: ["media_default", "bridge"],
          restartCount: 0,
          cpuTotalNs: 1_000_000_000,
          systemCpuNs: 100_000_000_000,
          memoryBytes: 500_000_000,
          netRxBytes: 4_000_000,
          netTxBytes: 1_000_000,
          blockReadBytes: 8_000_000,
          blockWriteBytes: 2_000_000,
        },
        {
          name: "broken",
          state: "exited",
          health: null,
          restartCount: 3,
          cpuTotalNs: null,
          systemCpuNs: null,
          memoryBytes: null,
          netRxBytes: null,
          netTxBytes: null,
          blockReadBytes: null,
          blockWriteBytes: null,
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
      sampledAt: at,
      containers: [
        {
          name: "jellyfin",
          state: "running",
          health: "healthy",
          stableId: "ctr-107f331d4217e3f4",
          composeProject: "media-stack",
          composeService: "jellyfin",
          networkNames: ["media_default", "bridge"],
          restartCount: 0,
          // +2e9 container ns over +200e9 system ns on 2 cores = 0.02 cores
          cpuTotalNs: 3_000_000_000,
          systemCpuNs: 300_000_000_000,
          memoryBytes: 600_000_000,
          netRxBytes: 14_000_000,
          netTxBytes: 3_000_000,
          blockReadBytes: 18_000_000,
          blockWriteBytes: 5_000_000,
        },
        {
          name: "broken",
          state: "exited",
          health: null,
          restartCount: 3,
          cpuTotalNs: null,
          systemCpuNs: null,
          memoryBytes: null,
          netRxBytes: null,
          netTxBytes: null,
          blockReadBytes: null,
          blockWriteBytes: null,
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
    expect(jellyfin.stableId).toBe("ctr-107f331d4217e3f4");
    expect(jellyfin.composeProject).toBe("media-stack");
    expect(jellyfin.composeService).toBe("jellyfin");
    expect(jellyfin.networkNames).toEqual(["media_default", "bridge"]);
    expect(jellyfin.netRxBps).toBeCloseTo(5_000_000, 3);
    expect(jellyfin.netTxBps).toBeCloseTo(1_000_000, 3);
    expect(jellyfin.blockReadBps).toBeCloseTo(5_000_000, 3);
    expect(jellyfin.blockWriteBps).toBeCloseTo(1_500_000, 3);
    const broken = docker.containers.find((c) => c.name === "broken")!;
    expect(broken.cpuFraction).toBeNull();
    expect(broken.state).toBe("exited");
  });

  it("keeps unfamiliar Docker runtime states explicitly unknown", () => {
    const first = sample(1000);
    const current = advance(3000);
    if (
      first.docker.status !== "ok" ||
      !first.docker.containers ||
      current.docker.status !== "ok" ||
      !current.docker.containers
    ) throw new Error("fixture docker telemetry missing");
    first.docker.containers.push({
      ...first.docker.containers[0]!,
      name: "future-runtime",
      state: "migrating",
    });
    current.docker.containers.push({
      ...current.docker.containers[0]!,
      name: "future-runtime",
      state: "migrating",
    });

    const docker = normalizeHostTelemetry(first, current).docker.value!;
    expect(docker.containers.find((c) => c.name === "future-runtime")?.state).toBe("unknown");
    expect(docker.total).toBe(3);
    expect(docker.running).toBe(1);
  });

  it("uses docker section sampledAt for deltas and preserves repeated cached samples", () => {
    const first = sample(1000, {
      docker: {
        status: "ok",
        sampledAt: 2000,
        containers: [
          {
            name: "jellyfin",
            state: "running",
            health: "healthy",
            restartCount: 0,
            cpuTotalNs: 1_000_000_000,
            systemCpuNs: 100_000_000_000,
            memoryBytes: 500_000_000,
            netRxBytes: 4_000,
            netTxBytes: 2_000,
            blockReadBytes: 8_000,
            blockWriteBytes: 6_000,
          },
        ],
      },
    } as Partial<RawHostSample>);
    const second = sample(3000, {
      docker: {
        status: "ok",
        sampledAt: 7000,
        containers: [
          {
            name: "jellyfin",
            state: "running",
            health: "healthy",
            restartCount: 0,
            cpuTotalNs: 3_000_000_000,
            systemCpuNs: 300_000_000_000,
            memoryBytes: 600_000_000,
            netRxBytes: 19_000,
            netTxBytes: 7_000,
            blockReadBytes: 18_000,
            blockWriteBytes: 11_000,
          },
        ],
      },
    } as Partial<RawHostSample>);
    const fresh = normalizeHostTelemetry(first, second);
    const jellyfin = fresh.docker.value!.containers[0]!;
    expect(fresh.docker.updatedAt).toBe(7000);
    expect(jellyfin.netRxBps).toBeCloseTo(3_000, 3);
    expect(jellyfin.netTxBps).toBeCloseTo(1_000, 3);
    const repeated = sample(5000, {
      docker: second.docker,
    } as Partial<RawHostSample>);
    const cached = normalizeHostTelemetry(second, repeated, fresh);
    expect(cached.docker.updatedAt).toBe(7000);
    expect(cached.docker.value).toEqual(fresh.docker.value);
  });

  it("ignores host polls that repeat Docker sample A, then rates sample B across the real 5s window", () => {
    const dockerAt = (sampledAt: number, hostAt: number, netRxBytes: number) =>
      sample(hostAt, {
        docker: {
          status: "ok",
          sampledAt,
          containers: [
            {
              name: "jellyfin",
              state: "running",
              health: "healthy",
              restartCount: 0,
              cpuTotalNs: sampledAt,
              systemCpuNs: sampledAt * 10,
              memoryBytes: 500_000_000,
              netRxBytes,
              netTxBytes: netRxBytes,
              blockReadBytes: netRxBytes,
              blockWriteBytes: netRxBytes,
            },
          ],
        },
      } as Partial<RawHostSample>);

    const at0 = dockerAt(0, 0, 1_000);
    const normalized0 = normalizeHostTelemetry(null, at0);
    const at2 = dockerAt(0, 2_000, 1_000);
    const normalized2 = normalizeHostTelemetry(at0, at2, normalized0);
    const at4 = dockerAt(0, 4_000, 1_000);
    const normalized4 = normalizeHostTelemetry(at2, at4, normalized2);
    expect(normalized2.docker).toEqual(normalized0.docker);
    expect(normalized4.docker).toEqual(normalized0.docker);

    const at5 = dockerAt(5_000, 5_000, 11_000);
    const normalized5 = normalizeHostTelemetry(at4, at5, normalized4);
    expect(normalized5.docker.updatedAt).toBe(5_000);
    expect(normalized5.docker.value!.containers[0]!.netRxBps).toBe(2_000);
  });

  it("keeps docker counter rates null for new, missing, or reset counters", () => {
    const prev = sample(1000, {
      docker: {
        status: "ok",
        sampledAt: 1000,
        containers: [
          {
            name: "steady",
            state: "running",
            health: "healthy",
            restartCount: 0,
            cpuTotalNs: 1,
            systemCpuNs: 10,
            memoryBytes: 10,
            netRxBytes: 100,
            netTxBytes: 200,
            blockReadBytes: 300,
            blockWriteBytes: 400,
          },
        ],
      },
    } as Partial<RawHostSample>);
    const curr = sample(3000, {
      docker: {
        status: "ok",
        sampledAt: 3000,
        containers: [
          {
            name: "steady",
            state: "running",
            health: "healthy",
            restartCount: 0,
            cpuTotalNs: 2,
            systemCpuNs: 20,
            memoryBytes: 20,
            netRxBytes: 50,
            netTxBytes: null,
            blockReadBytes: 350,
            blockWriteBytes: 450,
          },
          {
            name: "newbie",
            state: "running",
            health: null,
            restartCount: 0,
            cpuTotalNs: 5,
            systemCpuNs: 20,
            memoryBytes: 5,
            netRxBytes: 10,
            netTxBytes: 20,
            blockReadBytes: 30,
            blockWriteBytes: 40,
          },
        ],
      },
    } as Partial<RawHostSample>);
    const snap = normalizeHostTelemetry(prev, curr);
    const byName = Object.fromEntries(
      snap.docker.value!.containers.map((container) => [container.name, container]),
    ) as Record<string, NonNullable<typeof snap.docker.value>["containers"][number]>;
    expect(byName.steady!.netRxBps).toBeNull();
    expect(byName.steady!.netTxBps).toBeNull();
    expect(byName.newbie!.netRxBps).toBeNull();
    expect(byName.newbie!.blockReadBps).toBeNull();
  });

  it("sanitizes additive docker topology identity fields", () => {
    const prev = sample(1000);
    const curr = sample(3000, {
      docker: {
        status: "ok",
        sampledAt: 3000,
        containers: [
          {
            name: "safe",
            state: "running",
            health: "healthy",
            stableId: "CTR-ABC123",
            composeProject: "project-alpha",
            composeService: "svc_1",
            networkNames: ["media_default", "media_default", "bad/name", "bridge"],
            restartCount: 0,
            cpuTotalNs: 2,
            systemCpuNs: 20,
            memoryBytes: 20,
            netRxBytes: 200,
            netTxBytes: 300,
            blockReadBytes: 400,
            blockWriteBytes: 500,
          },
          {
            name: "unsafe",
            state: "running",
            health: null,
            stableId: "bad id",
            composeProject: "../secrets",
            composeService: "svc with spaces",
            networkNames: ["bad/name"],
            restartCount: 0,
            cpuTotalNs: 3,
            systemCpuNs: 30,
            memoryBytes: 30,
            netRxBytes: 300,
            netTxBytes: 400,
            blockReadBytes: 500,
            blockWriteBytes: 600,
          },
        ],
      },
    } as Partial<RawHostSample>);
    const docker = normalizeHostTelemetry(prev, curr).docker.value!;
    const byName = Object.fromEntries(
      docker.containers.map((container) => [container.name, container]),
    ) as Record<string, NonNullable<typeof docker>["containers"][number]>;
    expect(byName.safe!.stableId).toBe("ctr-abc123");
    expect(byName.safe!.composeProject).toBe("project-alpha");
    expect(byName.safe!.composeService).toBe("svc_1");
    expect(byName.safe!.networkNames).toEqual(["media_default", "bridge"]);
    expect(byName.unsafe!.stableId).toBeNull();
    expect(byName.unsafe!.composeProject).toBeNull();
    expect(byName.unsafe!.composeService).toBeNull();
    expect(byName.unsafe!.networkNames).toBeUndefined();
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

  it("uses the GPU section sampledAt for freshness tracking when present", () => {
    const snap = normalizeHostTelemetry(null, sample(3000, {
      gpu: {
        status: "ok",
        sampledAt: 1200,
        name: "NVIDIA GeForce GTX 1070",
        utilizationPercent: 12,
        vramUsedBytes: 2_097_152,
        vramTotalBytes: 8_589_934_592,
        temperatureC: 46,
        powerWatts: 11.8,
      },
    } as Partial<RawHostSample>));
    expect(snap.gpu.updatedAt).toBe(1200);
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

  it("ages a cached Docker observation stale without changing its rates or sample time", () => {
    const snap = normalizeHostTelemetry(sample(1_000), advance(3_000));
    const graded = gradeTelemetryFreshness(snap, 12_000, 6_000);
    expect(graded.docker.status).toBe("stale");
    expect(graded.docker.updatedAt).toBe(snap.docker.updatedAt);
    expect(graded.docker.value).toEqual(snap.docker.value);
  });

  it("marks Docker unavailable after last-known-good instead of emitting zero rates", () => {
    const previousRaw = advance(3_000);
    const previous = normalizeHostTelemetry(sample(1_000), previousRaw);
    const unavailableRaw = sample(5_000, {
      docker: { status: "unavailable" },
    } as Partial<RawHostSample>);
    const current = normalizeHostTelemetry(previousRaw, unavailableRaw, previous);
    expect(current.docker.status).toBe("unavailable");
    expect(current.docker.value).toBeNull();
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

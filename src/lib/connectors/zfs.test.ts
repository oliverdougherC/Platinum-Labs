import { describe, expect, it } from "vitest";
import {
  buildZfsSnapshot,
  createZfsConnector,
  mapPoolHealth,
  normalizeZfsCollector,
  parseZpoolList,
  parseZpoolStatus,
} from "@/lib/connectors/zfs";
import { ConnectorValidationError } from "@/lib/connectors/connector";

const TiB = 1024 ** 4;

const LIST = [
  `tank\t${20 * TiB}\t${12 * TiB}\t${8 * TiB}\tONLINE`,
  `backup\t${8 * TiB}\t${3 * TiB}\t${5 * TiB}\tDEGRADED`,
].join("\n");

const STATUS = `
  pool: tank
 state: ONLINE
  scan: scrub repaired 0B in 04:12:33 with 0 errors on Sun Aug  3 04:12:33 2025
config:
	NAME        STATE
	tank        ONLINE
errors: No known data errors

  pool: backup
 state: DEGRADED
  scan: scrub repaired 0B in 02:00:00 with 2 errors on Sat Aug  2 02:00:00 2025
errors: 2 data errors, use '-v' for a list

  pool: media
 state: ONLINE
  scan: scrub in progress since Mon Aug 11 09:00:00 2025
errors: No known data errors
`;

describe("mapPoolHealth", () => {
  it("recognizes known states and defaults unknown to UNAVAIL", () => {
    expect(mapPoolHealth("online")).toBe("ONLINE");
    expect(mapPoolHealth("DEGRADED")).toBe("DEGRADED");
    expect(mapPoolHealth("weird")).toBe("UNAVAIL");
    expect(mapPoolHealth(undefined)).toBe("UNAVAIL");
  });
});

describe("parseZpoolList", () => {
  it("parses multiple pools with exact bytes and health", () => {
    const pools = parseZpoolList(LIST);
    expect(pools).toHaveLength(2);
    expect(pools[0]).toMatchObject({ name: "tank", size: 20 * TiB, alloc: 12 * TiB, health: "ONLINE" });
    expect(pools[1]!.health).toBe("DEGRADED");
  });

  it("is resilient to malformed / missing output", () => {
    expect(parseZpoolList("")).toEqual([]); // missing command → empty
    expect(parseZpoolList("garbage line without tabs")).toEqual([]);
    expect(parseZpoolList("only\ttwo")).toEqual([]);
  });
});

describe("parseZpoolStatus", () => {
  it("captures scrub state, errors, and completion time per pool", () => {
    const scrub = parseZpoolStatus(STATUS);
    expect(scrub.tank!.state).toBe("completed");
    expect(scrub.tank!.errors).toBe(0);
    expect(typeof scrub.tank!.lastScrubAt).toBe("number");

    expect(scrub.backup!.state).toBe("completed");
    expect(scrub.backup!.errors).toBe(2); // scrub errors

    expect(scrub.media!.state).toBe("in-progress");
  });
});

describe("buildZfsSnapshot", () => {
  it("combines capacity + scrub into normalized pools", () => {
    const snap = buildZfsSnapshot(parseZpoolList(LIST), parseZpoolStatus(STATUS));
    expect(snap.pools).toHaveLength(2);
    const tank = snap.pools[0]!;
    expect(tank.capacityFraction).toBeCloseTo(12 / 20, 5);
    expect(tank.health).toBe("ONLINE");
    expect(tank.scrubErrors).toBe(0);
    const backup = snap.pools[1]!;
    expect(backup.health).toBe("DEGRADED");
    expect(backup.scrubErrors).toBe(2);
  });

  it("preserves the scan/scrub state on the normalized pool (PLA-184)", () => {
    const snap = buildZfsSnapshot(parseZpoolList(LIST), parseZpoolStatus(STATUS));
    // tank's scrub has completed in the fixture.
    expect(snap.pools.find((p) => p.name === "tank")!.scan).toBe("finished");
    // A pool with no scan data defaults to "none".
    expect(buildZfsSnapshot(parseZpoolList(LIST)).pools[0]!.scan).toBe("none");
  });

  it("empty input yields an empty pool set (missing command)", () => {
    expect(buildZfsSnapshot([]).pools).toEqual([]);
  });
});

describe("normalizeZfsCollector (helper-API path)", () => {
  it("normalizes helper JSON", () => {
    const snap = normalizeZfsCollector({
      pools: [{ name: "tank", size: 20 * TiB, alloc: 17 * TiB, free: 3 * TiB, health: "ONLINE", scrubErrors: 0 }],
    });
    expect(snap.pools[0]!.capacityFraction).toBeCloseTo(17 / 20, 5);
  });

  it("rejects malformed helper JSON", () => {
    expect(() => normalizeZfsCollector({ pools: [{ name: "x" }] })).toThrow(
      ConnectorValidationError,
    );
  });
});

describe("createZfsConnector", () => {
  it("delegates to the injected collect fn", async () => {
    const connector = createZfsConnector({ pollIntervalMs: 60_000 }, async () =>
      buildZfsSnapshot(parseZpoolList(LIST), parseZpoolStatus(STATUS)),
    );
    expect(connector.id).toBe("zfs");
    const snap = await connector.poll(new AbortController().signal);
    expect(snap.pools).toHaveLength(2);
  });
});

// --- PLA-264 regression: the live p910 audit shape --------------------------
//
// Exact byte values captured from the real server on 2026-08-15. These anchor
// the physical/logical split so raw zpool SIZE can never again be presented as
// usable capacity.

import { composeZfsPool, parseZfsList, type RawPool } from "@/lib/connectors/zfs";

const P910_LIST = [
  "DataStore\t95983929131008\t83139188277248\t12844740853760\t25\tONLINE",
  "NVME\t1992864825344\t347735359488\t1645129465856\t5\tONLINE",
  "eSATA\t32006096289792\t503808\t32006095785984\t0\tONLINE",
].join("\n");

const P910_ZFS_LIST = [
  "DataStore\t60405816351744\t9195068204032",
  "NVME\t365613420544\t1565511249920",
  "NVME/swap\t73020735488\t1583391899648",
  "eSATA\t437880\t27680359141768",
].join("\n");

describe("PLA-264 — physical vs logical capacity on the live topology", () => {
  it("parses the 6-column zpool list with FRAG", () => {
    const pools = parseZpoolList(P910_LIST);
    expect(pools).toHaveLength(3);
    expect(pools[0]).toMatchObject({
      name: "DataStore",
      size: 95_983_929_131_008,
      alloc: 83_139_188_277_248,
      frag: 25,
      health: "ONLINE",
    });
  });

  it("still parses the legacy 5-column form without FRAG", () => {
    const pools = parseZpoolList("DataStore\t100\t50\t50\tONLINE");
    expect(pools[0]).toMatchObject({ name: "DataStore", frag: null, health: "ONLINE" });
  });

  it("parses root datasets only from zfs list output", () => {
    const datasets = parseZfsList(P910_ZFS_LIST);
    expect(Object.keys(datasets).sort()).toEqual(["DataStore", "NVME", "eSATA"].sort());
    expect(datasets.DataStore).toMatchObject({
      used: 60_405_816_351_744,
      avail: 9_195_068_204_032,
    });
    // NVME/swap (nested) must never override the root dataset.
    expect(datasets.NVME!.used).toBe(365_613_420_544);
  });

  it("headline capacity is logical USED/(USED+AVAIL), never raw physical", () => {
    const snap = buildZfsSnapshot(parseZpoolList(P910_LIST), {}, parseZfsList(P910_ZFS_LIST));
    const ds = snap.pools.find((p) => p.name === "DataStore")!;
    expect(ds.capacityBasis).toBe("logical");
    // 69.6 TB logical total — NOT the 96.0 TB raw / 87.3 TiB that V1 displayed.
    expect(ds.totalBytes).toBe(60_405_816_351_744 + 9_195_068_204_032);
    expect(ds.usedBytes).toBe(60_405_816_351_744);
    expect(ds.capacityFraction).toBeCloseTo(0.8679, 3);
    // Physical view preserved for the detail drawer.
    expect(ds.allocation.sizeBytes).toBe(95_983_929_131_008);
    expect(ds.allocation.capFraction).toBeCloseTo(0.8662, 3);
    expect(ds.allocation.fragPercent).toBe(25);
  });

  it("degrades to labeled physical when the collector has no dataset info", () => {
    const raw: RawPool = {
      name: "DataStore",
      size: 95_983_929_131_008,
      alloc: 83_139_188_277_248,
      free: 12_844_740_853_760,
      health: "ONLINE",
      frag: null,
    };
    const pool = composeZfsPool(raw, undefined, undefined);
    expect(pool.capacityBasis).toBe("pool-allocation");
    expect(pool.logical).toBeNull();
    expect(pool.totalBytes).toBe(95_983_929_131_008);
  });

  it("normalizes the extended collector payload with logical fields", () => {
    const snap = normalizeZfsCollector({
      pools: [
        {
          name: "eSATA",
          size: 32_006_096_289_792,
          alloc: 503_808,
          free: 32_006_095_785_984,
          health: "ONLINE",
          frag: 0,
          logicalUsed: 437_880,
          logicalAvail: 27_680_359_141_768,
          scanState: "finished",
          lastScrubAt: 1_754_000_000_000,
          scrubErrors: 0,
        },
      ],
    });
    const pool = snap.pools[0]!;
    expect(pool.capacityBasis).toBe("logical");
    expect(pool.totalBytes).toBe(437_880 + 27_680_359_141_768);
    expect(pool.allocation.sizeBytes).toBe(32_006_096_289_792);
    expect(pool.scan).toBe("finished");
  });

  it("accepts the OLD deployed collector payload (no logical/frag fields)", () => {
    const snap = normalizeZfsCollector({
      pools: [
        { name: "DataStore", size: 100, alloc: 87, free: 13, health: "ONLINE" },
      ],
    });
    expect(snap.pools[0]!.capacityBasis).toBe("pool-allocation");
    expect(snap.pools[0]!.logical).toBeNull();
  });
});

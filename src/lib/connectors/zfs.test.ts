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

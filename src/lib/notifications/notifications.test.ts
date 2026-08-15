import { describe, expect, it } from "vitest";
import {
  dismissAlert,
  dismissGroup,
  emptyPrefs,
  groupNotifications,
  hasCritical,
  itemVisibility,
  prunePrefs,
  snoozeGroup,
  toggleMuteRule,
  toggleMuteSource,
} from "@/lib/notifications/center";
import {
  loadPrefs,
  parsePrefs,
  PREFS_STORAGE_KEY,
  savePrefs,
} from "@/lib/notifications/persistence";
import type { AttentionItem } from "@/lib/types";

const NOW = 1_754_000_000_000;
const MIN = 60_000;

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    ruleId: "qbittorrent.transfer.stalled",
    alertId: "qbittorrent.transfer.stalled:q-1",
    severity: "warning",
    title: "Transfer stalled",
    detail: "Something stalled",
    source: "qbittorrent",
    subject: "q-1",
    firstSeenAt: NOW - 30 * MIN,
    lastSeenAt: NOW,
    ...overrides,
  };
}

describe("grouping", () => {
  it("collapses related alerts into one titled group", () => {
    const items = [
      item({ alertId: "r:1", ruleId: "qbittorrent.transfer.stalled", source: "radarr", subject: "a" }),
      item({ alertId: "r:2", ruleId: "qbittorrent.transfer.stalled", source: "radarr", subject: "b" }),
    ];
    const { groups } = groupNotifications(items, emptyPrefs(), NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.title).toBe("Radarr · 2 stalled downloads");
    expect(groups[0]!.items).toHaveLength(2);
  });

  it("orders critical before warning, keeps distinct sources separate", () => {
    const items = [
      item(),
      item({
        alertId: "zfs.pool.not-online:eSATA",
        ruleId: "zfs.pool.not-online",
        source: "zfs",
        severity: "critical",
        title: "Pool eSATA degraded",
      }),
    ];
    const { groups } = groupNotifications(items, emptyPrefs(), NOW);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.severity).toBe("critical");
  });
});

describe("dismiss / snooze / mute semantics", () => {
  it("dismissing hides the same occurrence but a NEW occurrence reappears", () => {
    const a = item();
    let prefs = dismissAlert(emptyPrefs(), a.alertId, NOW);
    expect(itemVisibility(a, prefs, NOW + MIN)).toBe("dismissed");
    // Same alertId fires again LATER (new occurrence: firstSeenAt after dismissal).
    const reopened = item({ firstSeenAt: NOW + 10 * MIN, lastSeenAt: NOW + 11 * MIN });
    expect(itemVisibility(reopened, prefs, NOW + 11 * MIN)).toBe("visible");
    prefs = dismissAlert(prefs, reopened.alertId, NOW + 12 * MIN);
    expect(itemVisibility(reopened, prefs, NOW + 13 * MIN)).toBe("dismissed");
  });

  it("snooze hides until the deadline then reappears", () => {
    const group = groupNotifications([item()], emptyPrefs(), NOW).groups[0]!;
    const prefs = snoozeGroup(emptyPrefs(), group, NOW + 60 * MIN);
    expect(itemVisibility(item(), prefs, NOW + 30 * MIN)).toBe("snoozed");
    expect(itemVisibility(item(), prefs, NOW + 61 * MIN)).toBe("visible");
  });

  it("muting a rule or source hides matching items and is reversible", () => {
    let prefs = toggleMuteRule(emptyPrefs(), "qbittorrent.transfer.stalled");
    expect(itemVisibility(item(), prefs, NOW)).toBe("muted");
    prefs = toggleMuteRule(prefs, "qbittorrent.transfer.stalled");
    expect(itemVisibility(item(), prefs, NOW)).toBe("visible");

    prefs = toggleMuteSource(emptyPrefs(), "qbittorrent");
    expect(itemVisibility(item(), prefs, NOW)).toBe("muted");
  });

  it("group dismissal covers every item in the group", () => {
    const items = [item({ alertId: "x:1" }), item({ alertId: "x:2" })];
    const group = groupNotifications(items, emptyPrefs(), NOW).groups[0]!;
    const prefs = dismissGroup(emptyPrefs(), group, NOW);
    const after = groupNotifications(items, prefs, NOW + 1);
    expect(after.groups).toHaveLength(0);
    expect(after.hiddenCount).toBe(2);
  });

  it("hasCritical respects preferences", () => {
    const critical = item({ severity: "critical", alertId: "c:1", ruleId: "zfs.pool.not-online", source: "zfs" });
    expect(hasCritical([critical], emptyPrefs(), NOW)).toBe(true);
    const prefs = dismissAlert(emptyPrefs(), "c:1", NOW);
    expect(hasCritical([critical], prefs, NOW + 1)).toBe(false);
  });
});

describe("pruning (bounded persisted state)", () => {
  it("drops expired snoozes and ancient dismissals", () => {
    const prefs = {
      ...emptyPrefs(),
      dismissed: { fresh: NOW - MIN, ancient: NOW - 60 * 24 * 60 * MIN },
      snoozed: { future: NOW + MIN, past: NOW - MIN },
    };
    const pruned = prunePrefs(prefs, NOW);
    expect(Object.keys(pruned.dismissed)).toEqual(["fresh"]);
    expect(Object.keys(pruned.snoozed)).toEqual(["future"]);
  });
});

describe("persistence", () => {
  function memoryStorage(): Storage {
    const map = new Map<string, string>();
    return {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
      clear: () => map.clear(),
      key: () => null,
      length: 0,
    } as Storage;
  }

  it("round-trips prefs across a simulated refresh", () => {
    const storage = memoryStorage();
    const prefs = dismissAlert(emptyPrefs(), "a:1", NOW);
    savePrefs(prefs, NOW, storage);
    const loaded = loadPrefs(NOW + MIN, storage);
    expect(loaded.dismissed["a:1"]).toBe(NOW);
  });

  it("collapses malformed stored data to empty prefs", () => {
    expect(parsePrefs("not json")).toEqual(emptyPrefs());
    expect(parsePrefs(JSON.stringify({ dismissed: "nope", mutedRules: [1] }))).toEqual(
      emptyPrefs(),
    );
    expect(parsePrefs(null)).toEqual(emptyPrefs());
  });

  it("survives a throwing storage", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(loadPrefs(NOW, broken)).toEqual(emptyPrefs());
    expect(() => savePrefs(emptyPrefs(), NOW, broken)).not.toThrow();
  });

  it("uses a stable versioned storage key", () => {
    expect(PREFS_STORAGE_KEY).toBe("homelab.notifications.v1");
  });
});

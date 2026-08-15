import { describe, expect, it } from "vitest";
import { runCommand, suggestions, type CommandContext } from "@/lib/commands";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";

const links = [
  { label: "Jellyfin", href: "https://jellyfin.lan" },
  { label: "Radarr", href: "https://radarr.lan" },
];

function ctx(scenario: Parameters<typeof makeFakeSnapshot>[0] = "active"): CommandContext {
  const now = 1_754_000_000_000;
  return { snapshot: makeFakeSnapshot(scenario, now), links, now };
}

describe("runCommand — navigation", () => {
  it("opens a service by 'open <name>'", () => {
    const r = runCommand("open radarr", ctx());
    expect(r).toEqual({ kind: "navigate", label: "Radarr", href: "https://radarr.lan" });
  });
  it("opens a service by bare name", () => {
    const r = runCommand("jellyfin", ctx());
    // 'jellyfin' matches the link before the who-is-watching query.
    expect(r.kind).toBe("navigate");
  });
  it("gracefully handles 'open <unknown>'", () => {
    const r = runCommand("open proxmox", ctx());
    expect(r.kind).toBe("suggestions");
    if (r.kind === "suggestions") expect(r.message).toContain("proxmox");
  });
});

describe("runCommand — queries operate on normalized state", () => {
  it("who is watching (active playback)", () => {
    const r = runCommand("who is watching?", ctx("direct-play"));
    expect(r.kind).toBe("answer");
    if (r.kind === "answer") expect(r.lines.join(" ")).toMatch(/oliver/i);
  });
  it("who is watching (idle)", () => {
    const r = runCommand("who is watching", ctx("idle"));
    if (r.kind === "answer") expect(r.lines[0]).toMatch(/nobody/i);
  });
  it("downloads", () => {
    const r = runCommand("downloads", ctx("downloads"));
    expect(r.kind).toBe("answer");
    if (r.kind === "answer") expect(r.lines[0]).toMatch(/downloading/);
  });
  it("does not claim an empty download queue is clear when acquisition data is incomplete", () => {
    const c = ctx("idle");
    c.snapshot.acquisition.items = [];
    c.snapshot.health = c.snapshot.health.map((h) =>
      h.id === "qbittorrent" ? { ...h, status: "unavailable" } : h,
    );
    const r = runCommand("downloads", c);
    if (r.kind === "answer") expect(r.lines.join(" ")).toMatch(/unavailable|incomplete/i);
  });
  it("does not claim a stale empty download queue is clear", () => {
    const c = ctx("idle");
    c.snapshot.acquisition.items = [];
    c.snapshot.health = c.snapshot.health.map((h) =>
      h.id === "sonarr" ? { ...h, lastSuccessAt: c.now - h.pollIntervalMs * 4 } : h,
    );
    const r = runCommand("downloads", c);
    if (r.kind === "answer") expect(r.lines.join(" ")).toMatch(/unavailable|incomplete/i);
  });
  it("storage", () => {
    const r = runCommand("storage", ctx("idle"));
    if (r.kind === "answer") expect(r.lines.join(" ")).toMatch(/tank/);
  });
  it("issues (healthy vs attention)", () => {
    const healthy = runCommand("issues", ctx("idle"));
    if (healthy.kind === "answer") expect(healthy.lines[0]).toMatch(/good/i);
    const attn = runCommand("issues", ctx("zfs-degraded"));
    if (attn.kind === "answer") expect(attn.lines.join(" ")).toMatch(/degraded|critical|warning/i);
  });
  it("what was added today", () => {
    const r = runCommand("what was added today", ctx("active"));
    expect(r.kind).toBe("answer");
  });
  it("does not claim nothing was added when activity history is unavailable", () => {
    const c = ctx("idle");
    c.snapshot.activity = [];
    c.snapshot.activityAvailable = false;
    const r = runCommand("what was added today", c);
    if (r.kind === "answer") expect(r.lines.join(" ")).toMatch(/unavailable|incomplete/i);
  });
});

describe("runCommand — media search handoff (PLA-259)", () => {
  const enabled = (): CommandContext => ({ ...ctx(), mediaSearchEnabled: true });

  it("opens media search with a seeded query via 'request <title>'", () => {
    expect(runCommand("request dune part two", enabled())).toEqual({
      kind: "media-search",
      query: "dune part two",
    });
  });

  it("strips the media noun from 'find movie <title>'", () => {
    expect(runCommand("find movie interstellar", enabled())).toEqual({
      kind: "media-search",
      query: "interstellar",
    });
  });

  it("opens an unseeded search for the bare command", () => {
    expect(runCommand("request media", enabled())).toEqual({
      kind: "media-search",
      query: "",
    });
  });

  it("falls back to suggestions when the surface is not enabled", () => {
    const r = runCommand("request dune", ctx());
    expect(r.kind).toBe("suggestions");
    if (r.kind === "suggestions") expect(r.message).toMatch(/not configured/i);
  });

  it("advertises the command only when enabled", () => {
    expect(suggestions(enabled())).toContain("request media");
    expect(suggestions(ctx())).not.toContain("request media");
  });
});

describe("runCommand — graceful fallback", () => {
  it("empty input returns the suggestion list", () => {
    const r = runCommand("", ctx());
    expect(r.kind).toBe("suggestions");
    if (r.kind === "suggestions") expect(r.suggestions.length).toBeGreaterThan(0);
  });
  it("nonsense returns a helpful message + suggestions", () => {
    const r = runCommand("frobnicate the widget", ctx());
    expect(r.kind).toBe("suggestions");
    if (r.kind === "suggestions") {
      expect(r.message).toContain("frobnicate");
      expect(r.suggestions).toContain("storage");
    }
  });
  it("suggestions include configured links", () => {
    expect(suggestions(ctx())).toContain("open jellyfin");
  });
});

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

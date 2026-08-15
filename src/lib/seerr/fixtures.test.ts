import { describe, expect, it } from "vitest";
import { fakeSeerrRequest, fakeSeerrSearch } from "@/lib/seerr/fixtures";

describe("fakeSeerrSearch", () => {
  it("is deterministic and matches by substring, case-insensitively", () => {
    const a = fakeSeerrSearch("martian");
    const b = fakeSeerrSearch("MARTIAN");
    expect(a).toEqual(b);
    if (a.kind === "ok") {
      expect(a.results.map((r) => r.title)).toEqual(["The Martian"]);
    }
  });

  it("returns a mixed movie + TV catalog for a broad query", () => {
    const r = fakeSeerrSearch("th");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      const types = new Set(r.results.map((x) => x.mediaType));
      expect(types).toEqual(new Set(["movie", "tv"]));
    }
  });

  it("covers every media state across the catalog", () => {
    const r = fakeSeerrSearch("");
    if (r.kind === "ok") {
      const states = new Set(r.results.map((x) => x.state));
      for (const s of ["requestable", "pending", "processing", "partial", "available"]) {
        expect(states).toContain(s);
      }
    }
  });

  it("returns no results for an unmatched query", () => {
    expect(fakeSeerrSearch("zzzz-nothing")).toEqual({ kind: "ok", results: [] });
  });

  it('simulates Seerr downtime for the "offline" query', () => {
    expect(fakeSeerrSearch("offline")).toEqual({ kind: "unavailable" });
  });
});

describe("fakeSeerrRequest", () => {
  it("approves the plain requestable fixtures (immediate and via fallback)", () => {
    expect(fakeSeerrRequest("movie", 101)).toMatchObject({
      ok: true,
      outcome: "approved",
      title: "The Martian",
    });
    expect(fakeSeerrRequest("movie", 202)).toMatchObject({
      ok: true,
      outcome: "approved",
    });
    expect(fakeSeerrRequest("tv", 111)).toMatchObject({ ok: true, outcome: "approved" });
  });

  it("fails approval for the …3 fixture — pending is never success", () => {
    const r = fakeSeerrRequest("movie", 303);
    expect(r).toMatchObject({ ok: false, code: "approval-failed" });
  });

  it("fails request creation for the …4 fixture", () => {
    expect(fakeSeerrRequest("movie", 404)).toMatchObject({
      ok: false,
      code: "request-failed",
    });
  });

  it("returns stable already-requested states for tracked fixtures", () => {
    expect(fakeSeerrRequest("movie", 511)).toMatchObject({
      ok: true,
      outcome: "already-requested",
      state: "available",
    });
    expect(fakeSeerrRequest("tv", 432)).toMatchObject({
      ok: true,
      outcome: "already-requested",
      state: "pending",
    });
  });

  it("requests the missing seasons of the partial TV fixture", () => {
    expect(fakeSeerrRequest("tv", 322)).toMatchObject({ ok: true, outcome: "approved" });
  });
});

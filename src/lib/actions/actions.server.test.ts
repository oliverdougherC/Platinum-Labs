import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetActionRegistryForTests,
  getActionRegistry,
  SEERR_REQUEST_ACTION_ID,
} from "@/lib/actions/actions.server";
import { closeDb, getDb } from "@/lib/db/db.server";
import { countRows, recentEvents } from "@/lib/db/repository";
import { resetServerEnvCache } from "@/lib/env.server";

const API_KEY = "super-secret-api-key";

/** Configure live mode with an in-memory DB and a scripted Seerr upstream. */
function liveSeerrEnv(url: string): void {
  vi.stubEnv("HOMELAB_DATA_MODE", "live");
  vi.stubEnv("SEERR_URL", url);
  vi.stubEnv("SEERR_API_KEY", API_KEY);
  vi.stubEnv("HOMELAB_DB_PATH", ":memory:");
  resetServerEnvCache();
  __resetActionRegistryForTests();
}

function scriptedFetch(
  script: Record<string, () => Response>,
): typeof fetch {
  return vi.fn(async (url: unknown) => {
    const u = String(url);
    for (const [suffix, respond] of Object.entries(script)) {
      if (u.endsWith(suffix)) return respond();
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetServerEnvCache();
  __resetActionRegistryForTests();
  closeDb();
});

describe("seerr.request action wiring (live mode)", () => {
  it("persists a request.approved activity event and an audit row on success", async () => {
    // Distinct URL per test: the client cache is keyed on the config.
    liveSeerrEnv("http://seerr-a:5055");
    vi.stubGlobal(
      "fetch",
      scriptedFetch({
        "/api/v1/movie/101": () =>
          json({ id: 101, title: "The Martian", mediaInfo: undefined }),
        "/api/v1/request": () => json({ id: 900, status: 2 }),
      }),
    );

    const result = await getActionRegistry().execute(SEERR_REQUEST_ACTION_ID, {
      mediaType: "movie",
      mediaId: 101,
    });
    expect(result).toMatchObject({ status: "ok", audit: "approved" });

    const db = getDb();
    const events = recentEvents(db, 10);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "request.approved",
      severity: "info",
      source: "seerr",
      message: "Requested and approved: The Martian",
      subject: "movie:101",
    });
    expect(countRows(db, "action_audit")).toBe(1);
    expect(JSON.stringify(events)).not.toContain(API_KEY);
  });

  it("persists a request.failed warning when approval cannot be confirmed", async () => {
    liveSeerrEnv("http://seerr-b:5055");
    vi.stubGlobal(
      "fetch",
      scriptedFetch({
        "/api/v1/movie/303": () =>
          json({ id: 303, title: "Blade Runner 2049", mediaInfo: undefined }),
        "/api/v1/request": () => json({ id: 901, status: 1 }), // pending
        "/api/v1/request/901/approve": () =>
          new Response("denied", { status: 500 }),
      }),
    );

    const result = await getActionRegistry().execute(SEERR_REQUEST_ACTION_ID, {
      mediaType: "movie",
      mediaId: 303,
    });
    // The pending request is a FAILURE — never surfaced as success.
    expect(result).toMatchObject({ status: "ok", audit: "failed:approval-failed" });
    if (result.status === "ok") {
      expect(result.result).toMatchObject({ ok: false, code: "approval-failed" });
    }

    const events = recentEvents(getDb(), 10);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "request.failed",
      severity: "warning",
      source: "seerr",
    });
    expect(JSON.stringify(events)).not.toContain(API_KEY);
  });

  it("does not persist events for a stable already-requested outcome", async () => {
    liveSeerrEnv("http://seerr-c:5055");
    vi.stubGlobal(
      "fetch",
      scriptedFetch({
        "/api/v1/movie/511": () =>
          json({ id: 511, title: "Dune: Part Two", mediaInfo: { status: 5 } }),
      }),
    );

    const result = await getActionRegistry().execute(SEERR_REQUEST_ACTION_ID, {
      mediaType: "movie",
      mediaId: 511,
    });
    expect(result).toMatchObject({ status: "ok", audit: "already-requested" });

    const db = getDb();
    expect(recentEvents(db, 10)).toHaveLength(0);
    expect(countRows(db, "action_audit")).toBe(1); // audited, but no feed noise
  });
});

describe("seerr.request action wiring (fake mode)", () => {
  it("runs entirely without persistence", async () => {
    vi.stubEnv("HOMELAB_DB_PATH", ":memory:");
    resetServerEnvCache();
    __resetActionRegistryForTests();

    const result = await getActionRegistry().execute(SEERR_REQUEST_ACTION_ID, {
      mediaType: "movie",
      mediaId: 101,
    });
    expect(result).toMatchObject({ status: "ok" });
    expect(recentEvents(getDb(), 10)).toHaveLength(0);
  });
});

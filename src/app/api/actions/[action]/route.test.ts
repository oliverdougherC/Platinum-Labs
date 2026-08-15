import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/actions/[action]/route";
import { __resetActionRegistryForTests } from "@/lib/actions/actions.server";
import { resetServerEnvCache } from "@/lib/env.server";

function post(action: string, body?: unknown): Promise<Response> {
  return POST(
    new NextRequest(`http://localhost/api/actions/${action}`, {
      method: "POST",
      body: body === undefined ? "not json" : JSON.stringify(body),
    }),
    { params: Promise.resolve({ action }) },
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerEnvCache();
  __resetActionRegistryForTests();
});

describe("/api/actions/[action]", () => {
  it("rejects unregistered action ids — the browser cannot name arbitrary operations", async () => {
    const res = await post("shell.exec", { cmd: "rm -rf /" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("unknown-action");
  });

  it("rejects invalid input, including extra routing fields", async () => {
    for (const bad of [
      { mediaType: "movie" },
      { mediaType: "movie", mediaId: 101, profileId: 5 },
    ]) {
      const res = await post("seerr.request", bad);
      expect(res.status).toBe(400);
    }
  });

  it("rejects a non-JSON body as invalid input", async () => {
    const res = await post("seerr.request");
    expect(res.status).toBe(400);
  });

  it("executes the fake-mode request action to a confirmed approval", async () => {
    const res = await post("seerr.request", { mediaType: "movie", mediaId: 101 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      outcome: "approved",
      title: "The Martian",
    });
  });

  it("reports a stable already-requested state for tracked media", async () => {
    const res = await post("seerr.request", { mediaType: "movie", mediaId: 511 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      outcome: "already-requested",
      state: "available",
    });
  });

  it("surfaces an approval failure as a failure response, never success", async () => {
    const res = await post("seerr.request", { mediaType: "movie", mediaId: 303 });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, code: "approval-failed" });
  });

  it("refuses the action when Seerr is not configured in live mode", async () => {
    vi.stubEnv("HOMELAB_DATA_MODE", "live");
    resetServerEnvCache();
    __resetActionRegistryForTests();

    const res = await post("seerr.request", { mediaType: "movie", mediaId: 101 });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      code: "disabled",
      message: "Seerr is not configured",
    });
  });

  it("refuses the action when requests are disabled by the flag", async () => {
    vi.stubEnv("HOMELAB_DATA_MODE", "live");
    vi.stubEnv("SEERR_URL", "http://seerr:5055");
    vi.stubEnv("SEERR_API_KEY", "k");
    vi.stubEnv("SEERR_REQUESTS_ENABLED", "false");
    resetServerEnvCache();
    __resetActionRegistryForTests();

    const res = await post("seerr.request", { mediaType: "movie", mediaId: 101 });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      ok: false,
      code: "disabled",
      message: "Seerr requests are disabled",
    });
  });
});

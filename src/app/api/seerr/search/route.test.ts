import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/seerr/search/route";
import { resetServerEnvCache } from "@/lib/env.server";

const API_KEY = "super-secret-api-key";

function get(params: string): Promise<Response> {
  return GET(new NextRequest(`http://localhost/api/seerr/search?${params}`));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetServerEnvCache();
});

describe("/api/seerr/search — fake mode", () => {
  it("returns normalized fixture results with no-store caching", async () => {
    const res = await get("q=martian");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { results: Array<{ title: string }> };
    expect(body.results.map((r) => r.title)).toEqual(["The Martian"]);
  });

  it("rejects queries below the minimum length", async () => {
    const res = await get("q=a");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Enter at least 2 characters",
    );
  });

  it("rejects an over-long query", async () => {
    const res = await get(`q=${"x".repeat(200)}`);
    expect(res.status).toBe(400);
  });

  it("simulates Seerr downtime without touching the rest of the dashboard", async () => {
    const res = await get("q=offline");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Seerr is unreachable",
    );
  });
});

describe("/api/seerr/search — live mode", () => {
  it("returns 503 when Seerr is not configured", async () => {
    vi.stubEnv("HOMELAB_DATA_MODE", "live");
    resetServerEnvCache();
    const res = await get("q=martian");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Media search is not configured",
    );
  });

  it("proxies to Seerr with the API key server-side and never echoes it", async () => {
    vi.stubEnv("HOMELAB_DATA_MODE", "live");
    vi.stubEnv("SEERR_URL", "http://seerr:5055");
    vi.stubEnv("SEERR_API_KEY", API_KEY);
    resetServerEnvCache();

    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            page: 1,
            results: [
              {
                id: 1,
                mediaType: "movie",
                title: "Dune",
                releaseDate: "2021-09-15",
              },
              { id: 2, mediaType: "person", name: "Zendaya" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const res = await get("q=dune%20part");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results).toHaveLength(1); // person filtered

    // Auth header server-side; key never in URL or response.
    expect(calls[0]!.url).toBe(
      "http://seerr:5055/api/v1/search?query=dune%20part&page=1",
    );
    expect((calls[0]!.init.headers as Record<string, string>)["X-Api-Key"]).toBe(
      API_KEY,
    );
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });

  it("sanitizes upstream failures", async () => {
    vi.stubEnv("HOMELAB_DATA_MODE", "live");
    vi.stubEnv("SEERR_URL", "http://seerr:5055");
    vi.stubEnv("SEERR_API_KEY", API_KEY);
    resetServerEnvCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError(`connect ECONNREFUSED with ${API_KEY}`);
      }),
    );

    const res = await get("q=dune");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Seerr request failed");
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });

  it("surfaces malformed upstream payloads as sanitized errors", async () => {
    vi.stubEnv("HOMELAB_DATA_MODE", "live");
    vi.stubEnv("SEERR_URL", "http://seerr:5055");
    vi.stubEnv("SEERR_API_KEY", API_KEY);
    resetServerEnvCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ totally: "unexpected" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    const res = await get("q=dune");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Malformed upstream response");
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });
});

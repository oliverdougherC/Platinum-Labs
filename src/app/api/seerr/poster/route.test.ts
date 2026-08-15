import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/seerr/poster/route";

function get(params: string): Promise<Response> {
  return GET(new NextRequest(`http://localhost/api/seerr/poster?${params}`));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/api/seerr/poster", () => {
  it("rejects non-allowlisted sizes and non-poster paths", async () => {
    expect((await get("size=w9999&path=%2Fabc.jpg")).status).toBe(400);
    expect((await get("size=w92&path=%2Fa%2Fb.jpg")).status).toBe(400);
    expect(
      (await get("size=w92&path=https%3A%2F%2Fevil.example%2Fa.jpg")).status,
    ).toBe(400);
    expect((await get("size=w92")).status).toBe(400);
  });

  it("proxies a validated poster from the fixed TMDB origin with hard caching", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        calls.push(String(url));
        return new Response(new Uint8Array([0xff, 0xd8]), {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      }),
    );

    const res = await get("size=w92&path=%2Fabc123.jpg");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Cache-Control")).toContain("max-age=86400");
    expect(calls).toEqual(["https://image.tmdb.org/t/p/w92/abc123.jpg"]);
  });

  it("returns 502 when the upstream is not an image", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          }),
      ),
    );
    expect((await get("size=w92&path=%2Fabc123.jpg")).status).toBe(502);
  });

  it("returns 502 on upstream failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    expect((await get("size=w92&path=%2Fabc123.jpg")).status).toBe(502);
  });
});

import { describe, expect, it, vi } from "vitest";
import { ConnectorError } from "@/lib/connectors/connector";
import { makeSeerrClient, SeerrHttpError } from "@/lib/seerr/client.server";

const API_KEY = "super-secret-api-key";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function capture(response: Response | (() => Response)) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return typeof response === "function" ? response() : response.clone();
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function client(fetchImpl: typeof fetch, url = "http://seerr:5055") {
  return makeSeerrClient({ url, apiKey: API_KEY }, { fetchImpl, timeoutMs: 100 });
}

describe("makeSeerrClient", () => {
  it("sends the API key as X-Api-Key on every call and never in the URL", async () => {
    const { calls, fetchImpl } = capture(jsonResponse({ results: [] }));
    await client(fetchImpl).search("dune", 1);
    const [call] = calls;
    expect((call!.init.headers as Record<string, string>)["X-Api-Key"]).toBe(API_KEY);
    expect(call!.url).not.toContain(API_KEY);
  });

  it("builds /api/v1 URLs, trimming a trailing base slash", async () => {
    const { calls, fetchImpl } = capture(jsonResponse({ results: [] }));
    await client(fetchImpl, "http://seerr:5055/").search("dune", 2);
    expect(calls[0]!.url).toBe("http://seerr:5055/api/v1/search?query=dune&page=2");
  });

  it("URL-encodes the search query", async () => {
    const { calls, fetchImpl } = capture(jsonResponse({ results: [] }));
    await client(fetchImpl).search("dune: part two & more", 1);
    expect(calls[0]!.url).toContain(
      "query=dune%3A%20part%20two%20%26%20more",
    );
  });

  it("POSTs request payloads as JSON", async () => {
    const { calls, fetchImpl } = capture(jsonResponse({ id: 1, status: 2 }));
    await client(fetchImpl).createRequest({
      mediaType: "tv",
      mediaId: 42,
      seasons: "all",
    });
    const [call] = calls;
    expect(call!.url).toBe("http://seerr:5055/api/v1/request");
    expect(call!.init.method).toBe("POST");
    expect((call!.init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(call!.init.body as string)).toEqual({
      mediaType: "tv",
      mediaId: 42,
      seasons: "all",
    });
  });

  it("targets the approval endpoint by request id", async () => {
    const { calls, fetchImpl } = capture(jsonResponse({ id: 7, status: 2 }));
    await client(fetchImpl).approveRequest(7);
    expect(calls[0]!.url).toBe("http://seerr:5055/api/v1/request/7/approve");
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("throws SeerrHttpError with the status on non-2xx, without the body", async () => {
    const { fetchImpl } = capture(
      () => new Response(`{"message":"secret detail ${API_KEY}"}`, { status: 409 }),
    );
    const err = await client(fetchImpl).search("dune", 1).catch((e) => e);
    expect(err).toBeInstanceOf(SeerrHttpError);
    expect((err as SeerrHttpError).status).toBe(409);
    expect((err as Error).message).toBe("Seerr returned HTTP 409");
  });

  it("throws a sanitized error on non-JSON bodies", async () => {
    const { fetchImpl } = capture(() => new Response("<html>", { status: 200 }));
    await expect(client(fetchImpl).search("dune", 1)).rejects.toThrow(
      "Seerr returned non-JSON body",
    );
  });

  it("sanitizes network failures — no URL or key in the message", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed: http://seerr:5055 something");
    }) as unknown as typeof fetch;
    const err = await client(fetchImpl).search("dune", 1).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as Error).message).toBe("Seerr request failed");
    expect((err as Error).message).not.toContain(API_KEY);
  });

  it("aborts and reports a timeout when the upstream hangs", async () => {
    const fetchImpl = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      })) as unknown as typeof fetch;
    await expect(
      makeSeerrClient(
        { url: "http://seerr:5055", apiKey: API_KEY },
        { fetchImpl, timeoutMs: 20 },
      ).search("dune", 1),
    ).rejects.toThrow("Seerr request timed out after 20ms");
  });
});

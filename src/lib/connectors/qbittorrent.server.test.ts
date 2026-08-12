/**
 * Auth-hardening tests for the cookie-authenticated qBittorrent client (PLA-183).
 *
 * Drives `makeQbClient` against a mocked global `fetch` to prove the auth
 * invariants: a valid `Ok.` login with a parsed SID, rejected credentials, a
 * missing SID cookie, exactly one 403 → re-login → retry, a hard failure after a
 * second 403, non-2xx handling, and AbortSignal propagation. Every failure must
 * be a sanitized `ConnectorError` (or a bare AbortError) that never echoes
 * credentials, cookies, URLs, or bodies.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { makeQbClient } from "@/lib/connectors/qbittorrent.server";
import { ConnectorError } from "@/lib/connectors/connector";

const CFG = { url: "http://qb:8080/", username: "admin", password: "s3cr3t" };
const signal = new AbortController().signal;

interface MockRes {
  ok: boolean;
  status: number;
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
  headers?: { getSetCookie?: () => string[] };
}

function res(over: Partial<MockRes>): MockRes {
  return {
    ok: true,
    status: 200,
    text: async () => "Ok.",
    json: async () => ({ ok: true }),
    headers: { getSetCookie: () => ["SID=abc123; HttpOnly; path=/"] },
    ...over,
  };
}

const loginOk = () => res({});
const loginRejected = () => res({ text: async () => "Fails." });
const loginNoCookie = () => res({ headers: { getSetCookie: () => [] } });

/** Install a fetch that dispatches on url + method via the supplied handler. */
function install(handler: (url: string, method: string) => MockRes | Promise<MockRes>) {
  const fetchMock = vi.fn(async (url: string | URL, init?: { method?: string }) => {
    const r = await handler(String(url), init?.method ?? "GET");
    return r as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("makeQbClient auth", () => {
  it("logs in once, parses the SID, and returns torrent data with the cookie", async () => {
    let cookieSeen: string | undefined;
    const fetchMock = install((url, method) => {
      if (url.endsWith("/api/v2/auth/login") && method === "POST") return loginOk();
      return res({ json: async () => [{ hash: "x" }] });
    });
    const client = makeQbClient(CFG);
    const data = await client.torrentsInfo(signal);
    expect(data).toEqual([{ hash: "x" }]);

    // Second call reuses the SID — no second login.
    await client.torrentsInfo(signal);
    const logins = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/auth/login"));
    expect(logins).toHaveLength(1);

    // The data request carried the SID cookie.
    const dataCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/torrents/info"))!;
    cookieSeen = (dataCall[1] as { headers?: Record<string, string> })?.headers?.Cookie;
    expect(cookieSeen).toBe("SID=abc123");
  });

  it("rejects bad credentials (200 body 'Fails.') without echoing them", async () => {
    install((url) => (url.endsWith("/auth/login") ? loginRejected() : res({})));
    const client = makeQbClient(CFG);
    await expect(client.torrentsInfo(signal)).rejects.toBeInstanceOf(ConnectorError);
    await expect(client.torrentsInfo(signal)).rejects.toThrow(/credentials/);
    // The password must never appear in the error.
    await client.torrentsInfo(signal).catch((e: Error) => {
      expect(e.message).not.toContain("s3cr3t");
    });
  });

  it("fails when login returns no SID cookie", async () => {
    install((url) => (url.endsWith("/auth/login") ? loginNoCookie() : res({})));
    const client = makeQbClient(CFG);
    await expect(client.torrentsInfo(signal)).rejects.toThrow(/session cookie/);
  });

  it("re-authenticates exactly once on a 403, then succeeds", async () => {
    let dataCalls = 0;
    const fetchMock = install((url) => {
      if (url.endsWith("/auth/login")) return loginOk();
      dataCalls += 1;
      return dataCalls === 1
        ? res({ ok: false, status: 403 }) // first data call: session rejected
        : res({ json: async () => [{ hash: "y" }] }); // after re-login: ok
    });
    const client = makeQbClient(CFG);
    const data = await client.torrentsInfo(signal);
    expect(data).toEqual([{ hash: "y" }]);
    const logins = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/auth/login"));
    expect(logins).toHaveLength(2); // initial + one re-auth
  });

  it("gives up (sanitized) after a second consecutive 403", async () => {
    install((url) => (url.endsWith("/auth/login") ? loginOk() : res({ ok: false, status: 403 })));
    const client = makeQbClient(CFG);
    await expect(client.torrentsInfo(signal)).rejects.toThrow(/re-login/);
  });

  it("surfaces a non-2xx response as a sanitized error with only the status", async () => {
    install((url) => (url.endsWith("/auth/login") ? loginOk() : res({ ok: false, status: 500 })));
    const client = makeQbClient(CFG);
    await expect(client.torrentsInfo(signal)).rejects.toThrow(/HTTP 500/);
  });

  it("propagates an AbortError (timeout) from a data request", async () => {
    install((url) => {
      if (url.endsWith("/auth/login")) return loginOk();
      throw new DOMException("aborted", "AbortError");
    });
    const client = makeQbClient(CFG);
    await expect(client.torrentsInfo(signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("maps a network failure at login to a sanitized ConnectorError", async () => {
    install(() => {
      throw new TypeError("ECONNREFUSED 10.0.0.1:8080");
    });
    const client = makeQbClient(CFG);
    await client.transferInfo(signal).catch((e: Error) => {
      expect(e).toBeInstanceOf(ConnectorError);
      expect(e.message).not.toContain("10.0.0.1");
    });
  });
});

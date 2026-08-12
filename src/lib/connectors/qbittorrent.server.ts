import "server-only";

import { ConnectorError } from "@/lib/connectors/connector";
import type { QbClient } from "@/lib/connectors/qbittorrent";
import type { QbConfig } from "@/lib/connectors/config.server";

/**
 * Hardened, cookie-authenticated qBittorrent Web API client (PLA-183).
 *
 * Auth invariants:
 *  - login HTTP status is checked, and the body must be exactly `Ok.`
 *  - the `SID` cookie is parsed safely; a missing cookie is a hard error
 *  - requests never proceed without a valid SID
 *  - on 403 we re-authenticate at most once per request, then give up
 *  - non-403 responses have their status validated before `.json()`
 *  - all failures become sanitized `ConnectorError`s (status codes only, no
 *    credentials, URLs, cookies, or bodies) so nothing sensitive reaches health
 *  - the caller's `AbortSignal` (timeout) is threaded through every fetch
 *
 * This is the only place qBittorrent credentials are used; the normalizer in
 * `qbittorrent.ts` stays pure and secret-free.
 */
export function makeQbClient(cfg: QbConfig): QbClient {
  const root = cfg.url.replace(/\/$/, "");
  let sid: string | null = null;

  async function login(signal: AbortSignal): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${root}/api/v2/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:
          `username=${encodeURIComponent(cfg.username)}` +
          `&password=${encodeURIComponent(cfg.password)}`,
        signal,
        cache: "no-store",
        redirect: "manual",
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      throw new ConnectorError("qBittorrent login request failed");
    }

    if (!res.ok) {
      throw new ConnectorError(`qBittorrent login failed (HTTP ${res.status})`);
    }
    const body = (await res.text()).trim();
    if (body !== "Ok.") {
      // "Fails." (bad credentials) or a login-ban message — never echo the body.
      throw new ConnectorError("qBittorrent login rejected — check credentials");
    }
    const cookies = res.headers.getSetCookie?.() ?? [];
    const sidCookie = cookies.find((c) => c.startsWith("SID="));
    const parsed = sidCookie ? sidCookie.split(";")[0]!.slice("SID=".length) : null;
    if (!parsed) {
      throw new ConnectorError("qBittorrent login returned no session cookie");
    }
    sid = parsed;
  }

  async function get(
    path: string,
    signal: AbortSignal,
    isRetry = false,
  ): Promise<unknown> {
    if (!sid) await login(signal);

    let res: Response;
    try {
      res = await fetch(`${root}${path}`, {
        headers: sid ? { Cookie: `SID=${sid}` } : {},
        signal,
        cache: "no-store",
        redirect: "manual",
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      throw new ConnectorError("qBittorrent request failed");
    }

    if (res.status === 403) {
      if (isRetry) {
        throw new ConnectorError("qBittorrent authorization failed after re-login");
      }
      sid = null; // force exactly one re-authentication + retry
      return get(path, signal, true);
    }
    if (!res.ok) {
      throw new ConnectorError(`qBittorrent request failed (HTTP ${res.status})`);
    }
    return res.json();
  }

  return {
    torrentsInfo: (signal) => get("/api/v2/torrents/info", signal),
    transferInfo: (signal) => get("/api/v2/transfer/info", signal),
  };
}

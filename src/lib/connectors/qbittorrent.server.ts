import "server-only";

import { ConnectorError } from "@/lib/connectors/connector";
import type { QbClient } from "@/lib/connectors/qbittorrent";
import type { QbConfig } from "@/lib/connectors/config.server";

/**
 * Hardened, cookie-authenticated qBittorrent Web API client (PLA-183).
 *
 * Auth invariants:
 *  - login HTTP status is checked: any non-2xx is a hard failure, and a `Fails.`
 *    body (bad credentials) is rejected. qB <5 returns 200 `Ok.`; qB 5.x returns
 *    204 with an empty body — both are accepted.
 *  - the session cookie is captured verbatim as `name=value`. qB names it `SID`
 *    (older) or `QBT_SID_<port>` (5.x); we never assume the name. A missing
 *    session cookie is a hard error.
 *  - requests never proceed without a session cookie
 *  - on 403 we re-authenticate at most once per request, then give up
 *  - non-403 responses have their status validated before `.json()`
 *  - all failures become sanitized `ConnectorError`s (status codes only, no
 *    credentials, URLs, cookies, or bodies) so nothing sensitive reaches health
 *  - the caller's `AbortSignal` (timeout) is threaded through every fetch
 *
 * This is the only place qBittorrent credentials are used; the normalizer in
 * `qbittorrent.ts` stays pure and secret-free.
 */

/** qB's session cookie is `SID` (older) or `QBT_SID_<port>` (5.x). */
const QB_SESSION_COOKIE = /^(QBT_SID[^=]*|SID)=/;

export function makeQbClient(cfg: QbConfig): QbClient {
  const root = cfg.url.replace(/\/$/, "");
  // The full `name=value` session cookie, forwarded verbatim on each request.
  let cookie: string | null = null;

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
      // Bad credentials surface as 401/403 (5.x) — never echo the body.
      throw new ConnectorError(`qBittorrent login failed (HTTP ${res.status})`);
    }
    const body = (await res.text()).trim();
    if (body === "Fails.") {
      // qB <5 signals bad credentials with a 200 `Fails.` body.
      throw new ConnectorError("qBittorrent login rejected — check credentials");
    }
    const cookies = res.headers.getSetCookie?.() ?? [];
    const session = cookies
      .map((c) => c.split(";")[0]!)
      .find((c) => QB_SESSION_COOKIE.test(c));
    if (!session) {
      throw new ConnectorError("qBittorrent login returned no session cookie");
    }
    cookie = session;
  }

  async function get(
    path: string,
    signal: AbortSignal,
    isRetry = false,
  ): Promise<unknown> {
    if (!cookie) await login(signal);

    let res: Response;
    try {
      res = await fetch(`${root}${path}`, {
        headers: cookie ? { Cookie: cookie } : {},
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
      cookie = null; // force exactly one re-authentication + retry
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

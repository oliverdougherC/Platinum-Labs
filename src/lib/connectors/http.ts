import "server-only";

import { ConnectorError } from "@/lib/connectors/connector";

/**
 * Shared HTTP helper for real connectors (PLA-178).
 *
 * Centralizes the boundary rules so no connector leaks secrets:
 *  - honors the runtime's AbortSignal (timeout),
 *  - throws sanitized `ConnectorError`s that never echo the URL/headers (which
 *    may carry api_key query params or auth tokens),
 *  - returns parsed JSON as `unknown` so callers must validate with Zod.
 *
 * `server-only`: this must never enter a client bundle.
 */
export interface FetchJsonOptions {
  signal: AbortSignal;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  /** Label used in error messages instead of the raw URL. */
  label?: string;
}

export async function fetchJson(
  url: string,
  opts: FetchJsonOptions,
): Promise<unknown> {
  const label = opts.label ?? "upstream";
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: opts.headers,
      body: opts.body,
      signal: opts.signal,
      // Never reuse Next's data cache for live service polling.
      cache: "no-store",
    });
  } catch (err) {
    // AbortError (timeout) or network error — do not include the URL.
    if (err instanceof Error && err.name === "AbortError") {
      throw new ConnectorError(`${label} request aborted`);
    }
    throw new ConnectorError(`${label} request failed`);
  }

  if (!res.ok) {
    // Status is safe; body may echo secrets, so we don't include it.
    throw new ConnectorError(`${label} returned HTTP ${res.status}`);
  }

  try {
    return (await res.json()) as unknown;
  } catch {
    throw new ConnectorError(`${label} returned non-JSON body`);
  }
}

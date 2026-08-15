/**
 * Browser-facing quick links (PLA-191).
 *
 * These are URLs the *user's browser* opens (the dashboard may be viewed from a
 * laptop while services run on another host), so they are deliberately separate
 * from the server-side connector base URLs. Pure + isomorphic; the server reads
 * `HOMELAB_QUICK_LINKS` and validates with this before handing links to the
 * client.
 *
 * Security (PLA-193): only `http:`/`https:` navigation schemes are accepted —
 * `javascript:`, `data:`, `file:`, etc. are rejected so a quick link can never
 * become a script-execution vector.
 */

export interface QuickLink {
  label: string;
  href: string;
}

const SAFE_SCHEMES = new Set(["http:", "https:"]);

/** True only for a well-formed http(s) URL. */
export function isSafeLinkHref(href: string): boolean {
  try {
    return SAFE_SCHEMES.has(new URL(href).protocol);
  } catch {
    return false;
  }
}

/**
 * Validate an unknown value (typically parsed JSON) into a clean QuickLink[].
 * Anything malformed — non-array, missing fields, unsafe scheme — is dropped
 * rather than throwing, so one bad entry never breaks the launcher.
 */
export function parseQuickLinks(value: unknown): QuickLink[] {
  if (!Array.isArray(value)) return [];
  const out: QuickLink[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const label = (raw as { label?: unknown }).label;
    const href = (raw as { href?: unknown }).href;
    if (typeof label !== "string" || typeof href !== "string") continue;
    if (!label.trim() || !isSafeLinkHref(href)) continue;
    out.push({ label: label.trim(), href });
  }
  return out;
}

/** Parse the `HOMELAB_QUICK_LINKS` JSON string; invalid JSON yields no links. */
export function parseQuickLinksEnv(json: string | undefined): QuickLink[] {
  if (!json || !json.trim()) return [];
  try {
    return parseQuickLinks(JSON.parse(json));
  } catch {
    return [];
  }
}

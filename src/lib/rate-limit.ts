/**
 * Minimal in-memory sliding-window rate limiter (PLA-256).
 *
 * Guards the interactive Seerr endpoints against runaway loops (a stuck key
 * repeat, a client-side retry bug) on this single-process, single-operator
 * dashboard. Deliberately tiny: no distributed state, no per-client keys —
 * the deployment trust boundary is the private LAN/Tailscale network.
 */

export interface RateLimiter {
  /** Consume one slot; false when the window is exhausted. */
  tryAcquire(now?: number): boolean;
}

export function makeRateLimiter(opts: { windowMs: number; max: number }): RateLimiter {
  let windowStart = 0;
  let used = 0;
  return {
    tryAcquire(now = Date.now()): boolean {
      if (now - windowStart >= opts.windowMs) {
        windowStart = now;
        used = 0;
      }
      if (used >= opts.max) return false;
      used += 1;
      return true;
    },
  };
}

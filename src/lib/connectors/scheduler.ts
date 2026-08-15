import "server-only";

import type { ConnectorRuntime } from "@/lib/connectors/runtime";
import type { ConnectorHub } from "@/lib/connectors/hub";

/**
 * PollScheduler (PLA-178) — background pacing for the hub.
 *
 * Runs one timer per connector at its own `pollIntervalMs`, calling
 * `runtime.refresh()` (which is overlap-guarded). Because all browser clients
 * read the hub's cached state, a hundred open tabs still produce exactly one
 * upstream poll per interval — the "server-side cache so clients don't multiply
 * upstream polling" requirement.
 *
 * `server-only` and timer-based, so it is exercised in the running app rather
 * than unit tests (which drive `runtime.refresh()` / `hub.refreshAll()`
 * directly).
 */
export class PollScheduler {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private started = false;

  constructor(
    private readonly hub: ConnectorHub,
    private readonly runtimes: ConnectorRuntime<unknown>[],
  ) {}

  /**
   * Schedule each connector on its own cadence. By default it also primes the
   * cache with an immediate isolated fan-out; pass `prime: false` when the caller
   * has already performed (and awaited) the initial refresh to establish the
   * silent event baseline (see registry startup).
   */
  start(prime = true): void {
    if (this.started) return;
    this.started = true;

    if (prime) void this.hub.refreshAll();

    for (const rt of this.runtimes) {
      const interval = rt.getState().health.pollIntervalMs;
      const timer = setInterval(() => {
        void rt.refresh();
      }, interval);
      // Don't keep the process alive solely for polling.
      if (typeof timer === "object" && "unref" in timer) timer.unref();
      this.timers.set(rt.id, timer);
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    this.started = false;
  }

  get isRunning(): boolean {
    return this.started;
  }
}

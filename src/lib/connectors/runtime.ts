/**
 * ConnectorRuntime (PLA-178) — wraps a single Connector with the operational
 * behavior every service needs:
 *
 *  - a timeout backed by AbortController,
 *  - overlap protection (a second refresh while one is in-flight dedupes),
 *  - last-known-good retention across failures,
 *  - health derivation (healthy → degraded[serving stale] → unavailable),
 *  - client-safe error sanitization.
 *
 * The clock is injectable so tests are deterministic; no timers are started
 * here (the scheduler owns cadence).
 */

import { appConfig } from "@/lib/config";
import type { ConnectorHealth } from "@/lib/types";
import {
  ConnectorTimeoutError,
  sanitizeError,
  type Connector,
  type ConnectorState,
} from "@/lib/connectors/connector";

export interface RuntimeOptions {
  /** Per-poll timeout. Defaults to min(pollInterval, 8s). */
  timeoutMs?: number;
  /** How long stale LKG is "degraded" before becoming "unavailable". */
  graceMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** First backoff delay after a failure (doubles per consecutive failure). */
  backoffBaseMs?: number;
  /** Maximum backoff delay (the retry cadence never grows past this). */
  backoffMaxMs?: number;
  /** Injectable jitter in [0,1) for deterministic tests (default Math.random). */
  jitter?: () => number;
}

/** Race a poll against a timeout, aborting the signal when it fires. */
export async function pollWithTimeout<T>(
  connector: Connector<T>,
  timeoutMs: number,
): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
      reject(new ConnectorTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([connector.poll(ac.signal), timeout]);
  } catch (err) {
    // If the timer fired, report a timeout regardless of which rejection won
    // the race (a connector that rejects on abort must not mask the cause).
    if (timedOut) throw new ConnectorTimeoutError(timeoutMs);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Consecutive failures before capped backoff engages (one blip retries normally). */
const BACKOFF_AFTER_FAILURES = 2;

export class ConnectorRuntime<T> {
  private snapshot: T | null = null;
  private lastSuccessAt: number | null = null;
  private lastError: string | null = null;
  private inFlight: Promise<ConnectorState<T>> | null = null;

  private readonly timeoutMs: number;
  private readonly graceMs: number;
  private readonly now: () => number;

  // Capped exponential backoff with jitter on repeated failure, so a persistently
  // down service is retried on a bounded, decreasing cadence rather than hammered
  // every scheduler tick (PLA-194).
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly jitter: () => number;
  private consecutiveFailures = 0;
  private nextAttemptAt = 0;

  constructor(
    private readonly connector: Connector<T>,
    opts: RuntimeOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? Math.min(connector.pollIntervalMs, 8_000);
    this.graceMs = opts.graceMs ?? appConfig.thresholds.connectorGraceMs;
    this.now = opts.now ?? Date.now;
    this.backoffBaseMs = opts.backoffBaseMs ?? Math.min(connector.pollIntervalMs, 5_000);
    this.backoffMaxMs = opts.backoffMaxMs ?? 5 * 60_000;
    this.jitter = opts.jitter ?? Math.random;
  }

  get id() {
    return this.connector.id;
  }

  /** Current state without triggering a poll. */
  getState(): ConnectorState<T> {
    return { snapshot: this.snapshot, health: this.buildHealth() };
  }

  /**
   * Poll once, updating state. Overlapping calls share the in-flight poll so a
   * connector never runs two overlapping executions.
   */
  refresh(): Promise<ConnectorState<T>> {
    if (this.inFlight) return this.inFlight;
    // While backing off after repeated failures, a scheduler tick is a no-op —
    // this keeps a persistently-down service from being polled every interval
    // (and prevents poll pile-up) without affecting other connectors. A single
    // transient failure still retries at the normal cadence.
    if (this.isBackingOff()) {
      return Promise.resolve(this.getState());
    }
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** True when the runtime is currently within its backoff window. */
  isBackingOff(): boolean {
    return this.consecutiveFailures >= BACKOFF_AFTER_FAILURES && this.now() < this.nextAttemptAt;
  }

  private async doRefresh(): Promise<ConnectorState<T>> {
    try {
      const snapshot = await pollWithTimeout(this.connector, this.timeoutMs);
      this.snapshot = snapshot;
      this.lastSuccessAt = this.now();
      this.lastError = null;
      // Recovery: reset backoff so polling returns to normal cadence at once.
      this.consecutiveFailures = 0;
      this.nextAttemptAt = 0;
    } catch (err) {
      // Retain last-known-good; only the health/error changes.
      this.lastError = sanitizeError(err);
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= BACKOFF_AFTER_FAILURES) {
        const steps = this.consecutiveFailures - BACKOFF_AFTER_FAILURES;
        const capped = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** steps);
        // Jitter to 50–100% of the capped delay to avoid synchronized retries.
        const delay = capped * (0.5 + 0.5 * this.jitter());
        this.nextAttemptAt = this.now() + delay;
      }
    }
    return this.getState();
  }

  private buildHealth(): ConnectorHealth {
    const now = this.now();
    let status: ConnectorHealth["status"];

    if (this.lastError === null && this.lastSuccessAt !== null) {
      status = "healthy";
    } else if (this.snapshot !== null && this.lastSuccessAt !== null) {
      // We have last-known-good; degraded while within grace, else unavailable.
      status =
        now - this.lastSuccessAt <= this.graceMs ? "degraded" : "unavailable";
    } else {
      status = "unavailable";
    }

    return {
      id: this.connector.id,
      status,
      configured: true,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      configError: null,
      pollIntervalMs: this.connector.pollIntervalMs,
    };
  }
}

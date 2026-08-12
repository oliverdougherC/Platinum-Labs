/**
 * ConnectorHub (PLA-178) — registry + isolated fan-out over connector runtimes.
 *
 * `refreshAll` uses `Promise.allSettled` so one connector's failure (or timeout)
 * can never reject the aggregate: every other connector still refreshes and the
 * hub still returns partial, healthy data. This is the core resilience
 * guarantee — "one failed service must never break the homepage".
 */

import type { ConnectorHealth, ConnectorId } from "@/lib/types";
import type { ConnectorRuntime } from "@/lib/connectors/runtime";

export class ConnectorHub {
  private readonly runtimes = new Map<ConnectorId, ConnectorRuntime<unknown>>();

  register(runtime: ConnectorRuntime<unknown>): this {
    this.runtimes.set(runtime.id, runtime);
    return this;
  }

  has(id: ConnectorId): boolean {
    return this.runtimes.has(id);
  }

  /** Refresh every connector concurrently, isolated from each other's failures. */
  async refreshAll(): Promise<void> {
    await Promise.allSettled(
      [...this.runtimes.values()].map((rt) => rt.refresh()),
    );
  }

  /** Current health of every registered connector (no polling). */
  health(): ConnectorHealth[] {
    return [...this.runtimes.values()].map((rt) => rt.getState().health);
  }

  /** Last-known-good snapshot for a connector, or null. Caller supplies T. */
  snapshotOf<T>(id: ConnectorId): T | null {
    const rt = this.runtimes.get(id);
    return rt ? (rt.getState().snapshot as T | null) : null;
  }

  ids(): ConnectorId[] {
    return [...this.runtimes.keys()];
  }
}

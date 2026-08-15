/**
 * Safe action registry (PLA-192 concepts, first realized for PLA-258).
 *
 * The dashboard is mostly read-only; the few write operations it offers must go
 * through one narrow, auditable boundary instead of ad-hoc privileged POST
 * endpoints. An action is:
 *
 *  - allowlisted: the browser may only name a registered action id — there is
 *    no arbitrary URL/command/endpoint forwarding;
 *  - typed: input is validated with Zod before the handler runs;
 *  - gated: each action declares its own enablement check, so the UI/API can
 *    refuse cleanly when an integration is unconfigured or disabled;
 *  - idempotency-guarded: concurrent submissions with the same dedupe key share
 *    one in-flight execution, so a double-click can never run a handler twice;
 *  - audited: every execution reports a concise, secret-free result string that
 *    the server wiring persists to the audit trail.
 *
 * Pure data structures + logic only (no `server-only`, no I/O) so the registry
 * semantics are unit-testable; routes/wiring supply persistence.
 */

import type { ZodType } from "zod";

export interface ActionDefinition<In, Out> {
  id: string;
  /** Browser input schema — reject anything beyond the minimal trusted shape. */
  input: ZodType<In>;
  /** Why the action cannot run right now, or null when enabled. */
  disabledReason(): string | null;
  /** Executions sharing a dedupe key share one in-flight run. */
  dedupeKey(input: In): string;
  handler(input: In): Promise<Out>;
  /** Concise, secret-free audit line for a completed execution. */
  auditResult(outcome: Out): string;
}

export type ActionExecution<Out> =
  | { status: "ok"; result: Out; audit: string }
  | { status: "invalid-input" }
  | { status: "unknown-action" }
  | { status: "disabled"; reason: string };

export class ActionRegistry {
  private readonly actions = new Map<string, ActionDefinition<unknown, unknown>>();
  private readonly inFlight = new Map<string, Promise<ActionExecution<unknown>>>();

  register<In, Out>(action: ActionDefinition<In, Out>): void {
    if (this.actions.has(action.id)) {
      throw new Error(`action already registered: ${action.id}`);
    }
    this.actions.set(action.id, action as ActionDefinition<unknown, unknown>);
  }

  ids(): string[] {
    return [...this.actions.keys()];
  }

  /**
   * Validate, gate, dedupe, and run a registered action. Never throws for
   * browser-supplied input — every failure mode is an explicit status.
   */
  execute(id: string, rawInput: unknown): Promise<ActionExecution<unknown>> {
    const action = this.actions.get(id);
    if (!action) return Promise.resolve({ status: "unknown-action" });

    const parsed = action.input.safeParse(rawInput);
    if (!parsed.success) return Promise.resolve({ status: "invalid-input" });

    const reason = action.disabledReason();
    if (reason !== null) return Promise.resolve({ status: "disabled", reason });

    // Idempotency: identical concurrent submissions (double-click, React
    // strict-mode retry, network retry racing its predecessor) share the same
    // in-flight execution and therefore the same single upstream side effect.
    const key = `${id}:${action.dedupeKey(parsed.data)}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const run = action
      .handler(parsed.data)
      .then(
        (result): ActionExecution<unknown> => ({
          status: "ok",
          result,
          audit: action.auditResult(result),
        }),
      )
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, run);
    return run;
  }
}

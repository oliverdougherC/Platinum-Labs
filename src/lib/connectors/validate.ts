/**
 * Zod validation at the external API boundary (PLA-178).
 *
 * Real connectors parse every upstream payload through a schema before
 * normalizing it, so malformed/unexpected JSON becomes a clean
 * `ConnectorValidationError` (which the runtime surfaces as a sanitized health
 * error) rather than an uncaught runtime crash deep in the render path.
 */

import type { ZodType } from "zod";
import { ConnectorValidationError } from "@/lib/connectors/connector";

export function parseUpstream<T>(
  schema: ZodType<T>,
  data: unknown,
  label = "response",
): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.length ? first.path.join(".") : "(root)";
    throw new ConnectorValidationError(
      `${label} at ${where}: ${first?.message ?? "invalid"}`,
    );
  }
  return result.data;
}

import { getDataMode } from "@/lib/env.server";
import { getDashboardSnapshot, resolveScenario } from "@/lib/snapshot.server";

/**
 * Live dashboard stream (PLA-265) — Server-Sent Events.
 *
 * One connection replaces per-client interval polling for the high-frequency
 * path. Two event types:
 *
 *   `snapshot`  — the full `DashboardSnapshot` (5s cadence; also sent once on
 *                 connect so a client can render immediately).
 *   `telemetry` — `{telemetry, telemetryHistory, generatedAt}` only (2s
 *                 cadence in live mode; folded into `snapshot` in fake mode).
 *
 * The server does NOT fan out upstream polls per SSE client: all events read
 * the registry's cached state, so N viewers still cost one upstream poll per
 * connector interval. Clients reconnect with browser-native EventSource
 * backoff; `/api/dashboard` remains available as a polling fallback.
 */

export const dynamic = "force-dynamic";

const TELEMETRY_INTERVAL_MS = 2_000;
const SNAPSHOT_INTERVAL_MS = 5_000;
/** Comment heartbeat so proxies do not idle-close the stream. */
const HEARTBEAT_INTERVAL_MS = 15_000;

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const scenarioOverride = url.searchParams.get("scenario") ?? undefined;
  const mode = getDataMode();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const timers: ReturnType<typeof setInterval>[] = [];

      const close = () => {
        if (closed) return;
        closed = true;
        for (const t of timers) clearInterval(t);
        try {
          controller.close();
        } catch {
          // already closed by the runtime
        }
      };

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sseFrame(event, data)));
        } catch {
          close();
        }
      };

      request.signal.addEventListener("abort", close);

      const sendSnapshot = async () => {
        try {
          const snapshot = await getDashboardSnapshot({
            scenarioOverride: resolveScenario(scenarioOverride),
          });
          send("snapshot", snapshot);
        } catch {
          // A failed assembly must not kill the stream; the next tick retries.
        }
      };

      await sendSnapshot();

      if (mode === "live") {
        const { getLiveTelemetry } = await import("@/lib/dashboard/registry.server");
        const telemetryTick = async () => {
          try {
            send("telemetry", await getLiveTelemetry());
          } catch {
            // keep the stream open; snapshot ticks still carry state
          }
        };
        timers.push(setInterval(() => void telemetryTick(), TELEMETRY_INTERVAL_MS));
        timers.push(setInterval(() => void sendSnapshot(), SNAPSHOT_INTERVAL_MS));
      } else {
        // Fake mode: the full deterministic snapshot is cheap — tick it at the
        // telemetry cadence so the demo topology visibly breathes.
        timers.push(setInterval(() => void sendSnapshot(), TELEMETRY_INTERVAL_MS));
      }

      timers.push(
        setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            close();
          }
        }, HEARTBEAT_INTERVAL_MS),
      );
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

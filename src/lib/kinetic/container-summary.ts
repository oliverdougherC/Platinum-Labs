export function formatContainerRuntimeSummary(
  running: number | null,
  total: number | null,
): string | null {
  if (
    total === null ||
    !Number.isInteger(total) ||
    total < 0 ||
    (running !== null &&
      (!Number.isInteger(running) || running < 0 || running > total))
  ) {
    return null;
  }
  if (total === 0) return "0 containers";
  if (running === null) return `${total} ${total === 1 ? "container" : "containers"}`;
  return `${running} / ${total} ${total === 1 ? "container" : "containers"} running`;
}

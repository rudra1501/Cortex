/**
 * Minimal structured stage-timing logger.
 *
 * Rules:
 * - Never logs API keys, auth tokens, document content, prompts, or embeddings.
 * - Every line includes the requestId so logs for a single request can be
 *   filtered and sorted into a complete timeline.
 * - All timings use `performance.now()` (monotonic, sub-millisecond precision).
 */

/**
 * Checks whether verbose diagnostic/algorithmic logs are enabled.
 * Defaults to false so production logs stay clean and leak-free.
 */
export function isVerboseDebugEnabled(): boolean {
  return (
    process.env.LOG_LEVEL === "debug" ||
    process.env.DEBUG === "true" ||
    process.env.CORTEX_DEBUG === "true"
  );
}

/**
 * Emit one structured log line for a pipeline stage.
 *
 * @param requestId  Fastify request ID — ties every stage line to one request.
 * @param stage      Short dot-separated path, e.g. "embed.gemini", "db.vector".
 * @param data       Safe scalar fields: durations, counts, statuses — never content.
 */
export function stageLog(
  requestId: string | undefined,
  stage: string,
  data: Record<string, string | number | boolean | undefined>,
): void {
  if (process.env.ENABLE_PERF_LOGS === "false") {
    return;
  }

  const parts: string[] = [`[PERF] reqId=${requestId ?? "?"} stage=${stage}`];

  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      parts.push(`${key}=${value}`);
    }
  }

  console.log(parts.join(" "));
}

/** Returns elapsed milliseconds (integer) since a `performance.now()` mark. */
export function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

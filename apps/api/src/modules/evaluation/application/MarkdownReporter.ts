/**
 * MarkdownReporter — generates human-readable executive scorecard reports
 * in GitHub-flavored markdown comparing Experiment A vs Experiment B.
 *
 * Guarantees:
 * - Clear execution mode badge (Live, Candidate-Pool Replay, Cached-Ranking Replay).
 * - Prominent separation of finalised ground-truth metrics vs provisional metrics.
 * - Win / Tie / Loss distribution with win rate.
 * - Reranker telemetry and fallback breakdown.
 * - Clean "N/A" formatting for null metrics (no "NaN" or "null").
 * - Atomic file write via temporary file and rename.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type {
  EvaluationRunResult,
  EvaluationScorecard,
  EvaluationQueryRecord,
  AggregateMetricsGroup,
} from "../domain/EvaluationResult.js";

// ---------------------------------------------------------------------------
// Formatting Helpers
// ---------------------------------------------------------------------------

export function formatNumber(val: number | null | undefined, decimals = 4): string {
  if (val === null || val === undefined || Number.isNaN(val)) {
    return "N/A";
  }
  return val.toFixed(decimals);
}

export function formatDelta(val: number | null | undefined, decimals = 4): string {
  if (val === null || val === undefined || Number.isNaN(val)) {
    return "N/A";
  }
  const prefix = val > 0 ? "+" : "";
  const str = `${prefix}${val.toFixed(decimals)}`;
  if (val > 0.0001) {
    return `**${str}**`;
  }
  if (val < -0.0001) {
    return `*${str}*`;
  }
  return str;
}

export function formatPercent(val: number | null | undefined, decimals = 1): string {
  if (val === null || val === undefined || Number.isNaN(val)) {
    return "N/A";
  }
  return `${(val * 100).toFixed(decimals)}%`;
}

function computeRelativeChange(
  baseline: number | null | undefined,
  treatment: number | null | undefined,
): string {
  if (
    baseline === null ||
    baseline === undefined ||
    treatment === null ||
    treatment === undefined ||
    Number.isNaN(baseline) ||
    Number.isNaN(treatment)
  ) {
    return "N/A";
  }
  if (baseline === 0) {
    return treatment === 0 ? "0.0%" : "N/A";
  }
  const rel = (treatment - baseline) / baseline;
  const prefix = rel > 0 ? "+" : "";
  const str = `${prefix}${(rel * 100).toFixed(1)}%`;
  return rel > 0.001 ? `**${str}**` : str;
}

// ---------------------------------------------------------------------------
// MarkdownReporter Class
// ---------------------------------------------------------------------------

export class MarkdownReporter {
  /**
   * Generates the complete GitHub-flavored markdown evaluation report.
   */
  generate(
    result: EvaluationRunResult,
    executionMode: "live" | "candidate-pool-replay" | "cached-ranking-replay" = "live",
  ): string {
    const lines: string[] = [];
    const { scorecard, queryRecords } = result;
    const { runConfig, querySummary } = scorecard;

    // 1. Header & Title
    lines.push("# Retrieval Quality Evaluation Report");
    lines.push("");

    let modeBadge = "🚀 **Live Evaluation**";
    if (executionMode === "candidate-pool-replay") {
      modeBadge = "🔁 **Candidate-Pool Replay** *(Live Reranker, Cached Retrieval)*";
    } else if (executionMode === "cached-ranking-replay") {
      modeBadge = "💾 **Cached-Ranking Replay** *(Zero Gemini API Calls, Metric Re-evaluation)*";
    }
    lines.push(`**Execution Mode**: ${modeBadge}  `);
    lines.push(`**Run Date**: ${runConfig.runAt}  `);
    lines.push(`**Dataset Version**: ${runConfig.datasetVersion}  `);
    lines.push(
      `**Retrieval Strategy**: ${runConfig.retrievalStrategy} (RRF k=${runConfig.rrfK}, Similarity Threshold=${runConfig.similarityThreshold.toFixed(2)})  `,
    );
    lines.push(`**Embedding Model**: ${runConfig.embeddingModel}  `);
    lines.push(
      `**Reranker Model**: ${runConfig.rerankerModel ?? "None"} ${
        runConfig.rerankerTimeoutMs ? `(timeout: ${runConfig.rerankerTimeoutMs}ms)` : ""
      }  `,
    );
    lines.push(
      `**Candidate Pool Limit**: K=${runConfig.candidateK} | **Evaluation Top-K**: K=${runConfig.topK}`,
    );
    lines.push("");

    // Execution Mode Callout
    if (executionMode === "cached-ranking-replay") {
      lines.push("> [!NOTE]");
      lines.push(
        "> **Cached-Ranking Replay**: Replaying previously recorded candidate pools and reranker outputs. Zero Gemini API calls were made and zero tokens were consumed.",
      );
      lines.push("");
    } else if (executionMode === "candidate-pool-replay") {
      lines.push("> [!NOTE]");
      lines.push(
        "> **Candidate-Pool Replay**: Candidate pools were replayed from disk cache (skipping query embedding and database retrieval). Gemini reranking was executed live and consumed tokens.",
      );
      lines.push("");
    }

    lines.push("---");
    lines.push("");

    // 2. Executive Summary Table
    lines.push("## Executive Summary");
    lines.push("");
    lines.push("| Query Status | Count | Percentage |");
    lines.push("|:---|---:|---:|");
    lines.push(
      `| **Finalised Queries** (Complete Ground Truth) | ${querySummary.finalised} | ${formatPercent(
        querySummary.total > 0 ? querySummary.finalised / querySummary.total : 0,
      )} |`,
    );
    lines.push(
      `| **Provisional Queries** (Pending Review / Incomplete) | ${querySummary.provisional} | ${formatPercent(
        querySummary.total > 0 ? querySummary.provisional / querySummary.total : 0,
      )} |`,
    );
    lines.push(
      `| **Excluded from Metrics** (Zero Relevant Judgments) | ${querySummary.excludedFromMetrics} | ${formatPercent(
        querySummary.total > 0 ? querySummary.excludedFromMetrics / querySummary.total : 0,
      )} |`,
    );
    lines.push(`| **Total Benchmark Queries** | **${querySummary.total}** | **100.0%** |`);
    lines.push("");

    // 3. Finalised Scorecard
    lines.push("---");
    lines.push("");
    if (scorecard.finalisedMetrics && querySummary.finalised > 0) {
      lines.push(`## Finalised Benchmark Scorecard (N = ${querySummary.finalised})`);
      lines.push("");
      lines.push(
        "> [!NOTE]\n> **Finalised Metrics** represent human-reviewed ground truth with zero unjudged candidates in the candidate pool.",
      );
      lines.push("");
      lines.push(
        this.renderMetricsTable(
          scorecard.finalisedMetrics.experimentA,
          scorecard.finalisedMetrics.experimentB,
        ),
      );
      lines.push("");

      const wtl = scorecard.finalisedMetrics.deltas.winTieLossNdcg;
      const evaluatedCount = wtl.wins + wtl.ties + wtl.losses;
      const winRate = evaluatedCount > 0 ? wtl.wins / evaluatedCount : 0;
      lines.push("### Win / Tie / Loss Distribution (nDCG@5)");
      lines.push("");
      lines.push(`- **Wins** (Reranker Improved): **${wtl.wins}** (${formatPercent(winRate)})`);
      lines.push(
        `- **Ties** (Identical Quality): **${wtl.ties}** (${formatPercent(
          evaluatedCount > 0 ? wtl.ties / evaluatedCount : 0,
        )})`,
      );
      lines.push(
        `- **Losses** (Reranker Regressed): **${wtl.losses}** (${formatPercent(
          evaluatedCount > 0 ? wtl.losses / evaluatedCount : 0,
        )})`,
      );
      lines.push(`- **Excluded** (No Relevant Judgments): **${wtl.excluded}**`);
      lines.push("");
    } else {
      lines.push("## Finalised Benchmark Scorecard");
      lines.push("");
      lines.push("> [!IMPORTANT]");
      lines.push(
        `> **No Finalised Queries**: All ${querySummary.total} queries in this run contain unjudged candidates or provisional text-anchor matches. Finalised metrics are not certified.`,
      );
      lines.push("");
    }

    // 4. Reranker Performance & Telemetry Table
    lines.push("---");
    lines.push("");
    lines.push("## Reranker Performance & Telemetry");
    lines.push("");
    const telem = scorecard.rerankerTelemetrySummary;
    const successCount = querySummary.total - telem.fallbackCount;
    const successRate = querySummary.total > 0 ? successCount / querySummary.total : 0;

    lines.push("| Telemetry Dimension | Measurement |");
    lines.push("|:---|---:|");
    lines.push(`| **Median Latency** | ${telem.latencyMedianMs} ms |`);
    lines.push(`| **Mean Latency** | ${telem.latencyMeanMs} ms |`);
    lines.push(`| **Total Evaluated Requests** | ${querySummary.total} |`);
    lines.push(
      `| **Successful Reranks** | ${successCount} (${formatPercent(successRate)}) |`,
    );
    lines.push(
      `| **Fallback Count** | ${telem.fallbackCount} (${formatPercent(telem.fallbackRate)}) |`,
    );

    const reasons = Object.entries(telem.fallbackReasons);
    if (reasons.length > 0) {
      const reasonStr = reasons.map(([k, v]) => `\`${k}\`: ${v}`).join(", ");
      lines.push(`| **Fallback Reasons** | ${reasonStr} |`);
    } else {
      lines.push("| **Fallback Reasons** | None (0 fallbacks) |");
    }
    lines.push("");

    // 5. Provisional Scorecard (All Queries)
    lines.push("---");
    lines.push("");
    lines.push(`## All-Queries Scorecard (Illustrative / Provisional) (N = ${querySummary.total})`);
    lines.push("");
    lines.push("> [!WARNING]");
    lines.push(
      "> This table includes provisional and unfinalised queries. Do not use for production release gating.",
    );
    lines.push("");
    lines.push(
      this.renderMetricsTable(
        scorecard.allQueriesMetrics.experimentA,
        scorecard.allQueriesMetrics.experimentB,
      ),
    );
    lines.push("");

    // 6. Per-Query Detail Table
    lines.push("---");
    lines.push("");
    lines.push("## Per-Query Results");
    lines.push("");
    lines.push(
      "| Query ID | Question Preview | Category | Status | Exp A nDCG@5 | Exp B nDCG@5 | Delta | Telemetry |",
    );
    lines.push("|:---|:---|:---|:---:|---:|---:|---:|:---|");

    for (const q of queryRecords) {
      const isFinalised =
        !q.incompletenessFlags.unjudgedInEvalPool &&
        !q.incompletenessFlags.incompleteSources &&
        !q.incompletenessFlags.pendingReview;

      const isExcluded =
        q.experimentA.metrics.recall5Lenient === null &&
        q.experimentA.metrics.ndcg5 === null;

      let statusBadge = "✅ Finalised";
      if (isExcluded) {
        statusBadge = "⛔ Excluded";
      } else if (!isFinalised) {
        statusBadge = "⚠️ Provisional";
      }

      const truncatedQ =
        q.question.length > 40 ? `${q.question.slice(0, 37)}...` : q.question;

      let telemDesc: string = q.experimentB.telemetry.status;
      if (q.experimentB.telemetry.status === "fallback") {
        telemDesc = `fallback (${q.experimentB.telemetry.failureType ?? "unknown"}, ${
          q.experimentB.telemetry.latencyMs
        }ms)`;
      } else if (q.experimentB.telemetry.status === "success") {
        telemDesc = `success (${q.experimentB.telemetry.latencyMs}ms)`;
      }

      lines.push(
        `| \`${q.queryId}\` | ${truncatedQ.replace(/\|/g, "\\|")} | ${q.category ?? "default"} | ${statusBadge} | ${formatNumber(
          q.experimentA.metrics.ndcg5,
          3,
        )} | ${formatNumber(q.experimentB.metrics.ndcg5, 3)} | ${formatDelta(
          q.deltas.deltaNdcg5,
          3,
        )} | ${telemDesc} |`,
      );
    }
    lines.push("");

    return lines.join("\n");
  }

  /**
   * Atomically writes the markdown evaluation report to disk.
   */
  async writeReport(
    result: EvaluationRunResult,
    outputPath: string,
    executionMode: "live" | "candidate-pool-replay" | "cached-ranking-replay" = "live",
  ): Promise<string> {
    const md = this.generate(result, executionMode);
    const dir = path.dirname(outputPath);
    await fs.mkdir(dir, { recursive: true });

    const tempPath = `${outputPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    try {
      await fs.writeFile(tempPath, md, "utf-8");
      await fs.rename(tempPath, outputPath);
      return path.resolve(outputPath);
    } catch (err) {
      await fs.unlink(tempPath).catch(() => {});
      throw err;
    }
  }

  private renderMetricsTable(
    expA: AggregateMetricsGroup,
    expB: AggregateMetricsGroup,
  ): string {
    const rows = [
      {
        name: "**Candidate Recall@20 (Lenient)**",
        a: expA.candidateRecall20Lenient.mean,
        b: expB.candidateRecall20Lenient.mean,
      },
      {
        name: "**Candidate Recall@20 (Strict)**",
        a: expA.candidateRecall20Strict.mean,
        b: expB.candidateRecall20Strict.mean,
      },
      {
        name: "**Recall@5 (Lenient)**",
        a: expA.recall5Lenient.mean,
        b: expB.recall5Lenient.mean,
      },
      {
        name: "**Recall@5 (Strict)**",
        a: expA.recall5Strict.mean,
        b: expB.recall5Strict.mean,
      },
      {
        name: "**MRR@5**",
        a: expA.mrr5.mean,
        b: expB.mrr5.mean,
      },
      {
        name: "**nDCG@5**",
        a: expA.ndcg5.mean,
        b: expB.ndcg5.mean,
      },
    ];

    const lines: string[] = [];
    lines.push(
      "| Metric | Experiment A (HYBRID / RRF) | Experiment B (Gemini Reranker) | Delta (Exp B − Exp A) | Relative Change |",
    );
    lines.push("|:---|---:|---:|---:|---:|");

    for (const r of rows) {
      const delta =
        r.b !== null && r.a !== null ? r.b - r.a : null;
      const relChange = computeRelativeChange(r.a, r.b);

      lines.push(
        `| ${r.name} | ${formatNumber(r.a)} | ${formatNumber(r.b)} | ${formatDelta(
          delta,
        )} | ${relChange} |`,
      );
    }

    return lines.join("\n");
  }
}

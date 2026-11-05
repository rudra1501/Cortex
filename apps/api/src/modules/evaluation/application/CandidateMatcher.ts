/**
 * CandidateMatcher — dual-key resolution for candidate chunks against ground truth.
 *
 * Matching Policy:
 * 1. Strict Document Isolation:
 *    All matching is strictly scoped to `chunk.documentId === judgment.documentId`.
 *    documentTitle is display metadata only and is NEVER used for identity matching.
 *
 * 2. Exact ID Precedence & Conflict Detection:
 *    An exact `chunkId` match takes precedence over text-anchor matches if unique.
 *    Multiple judgments claiming the same chunkId resolve to `status: "ambiguous"`.
 *
 * 3. Text Anchor Matching & Multi-Anchor Collisions:
 *    If no exact ID match exists, textAnchor containment within chunk.content is checked.
 *    If multiple distinct anchors match one chunk, the result is `status: "ambiguous"`.
 *    Relevance labels are NEVER auto-merged, even if scores are identical.
 *
 * 4. Preservation of Unresolved States:
 *    Explicit relevance zero (confirmed irrelevant) is distinct from `unjudged` and
 *    `ambiguous`. Unresolved states map to `{ status: "unjudged" }` for MetricCalculator
 *    so they contribute 0 gain in DCG and 0 hits in Recall without false negative marking,
 *    while gating the query as provisional.
 */

import type { RetrievedChunk } from "../../retrieval/infrastructure/PgVectorRepository.js";
import type {
  CandidateChunk,
  IncompletenessFlags,
  JudgmentResolution,
} from "../domain/EvaluationResult.js";
import type { ItemJudgment } from "../domain/MetricCalculator.js";
import type {
  EvaluationJudgment,
  JudgmentPoolMetadata,
} from "../domain/EvaluationDataset.js";

// ---------------------------------------------------------------------------
// Text Normalization Helper
// ---------------------------------------------------------------------------

/**
 * Normalizes text for robust semantic anchor containment checking:
 * - Replaces tabs, newlines, and carriage returns with spaces.
 * - Collapses multiple consecutive spaces into a single space.
 * - Trims leading/trailing whitespace.
 * - Lowercases all characters.
 */
export function normalizeText(text: string): string {
  return text
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Single Candidate Resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a single retrieved chunk against the query's ground truth judgments.
 *
 * Scoped strictly to `chunk.documentId === judgment.documentId`.
 */
export function matchCandidate(
  chunk: RetrievedChunk,
  judgments: readonly EvaluationJudgment[],
): JudgmentResolution {
  // Step 1: Check Exact ID Match (with precedence)
  const exactMatches = judgments.filter(
    (j) =>
      j.chunkId !== undefined &&
      j.chunkId.trim().length > 0 &&
      j.chunkId.trim() === chunk.chunkId.trim() &&
      j.documentId === chunk.documentId,
  );

  if (exactMatches.length > 1) {
    // Multiple conflicting/duplicate judgments for the same chunk ID
    return {
      status: "ambiguous",
      reason: `Multiple judgments (${exactMatches.length}) exist for chunkId "${chunk.chunkId}"`,
      matchingJudgmentCount: exactMatches.length,
    };
  }

  if (exactMatches.length === 1) {
    const firstMatch = exactMatches[0];
    if (firstMatch) {
      return {
        status: "judged",
        relevance: firstMatch.relevance,
        matchType: "exact_id",
      };
    }
  }

  // Step 2: Check Text-Anchor Match (strictly scoped to the same documentId)
  const sameDocJudgments = judgments.filter(
    (j) => j.documentId === chunk.documentId,
  );

  const normalizedContent = normalizeText(chunk.content);

  const anchorMatches = sameDocJudgments.filter((j) => {
    const normalizedAnchor = normalizeText(j.textAnchor);
    return (
      normalizedAnchor.length > 0 && normalizedContent.includes(normalizedAnchor)
    );
  });

  if (anchorMatches.length === 0) {
    // No exact ID and no anchor match in this document
    return { status: "unjudged" };
  }

  if (anchorMatches.length === 1) {
    const firstAnchor = anchorMatches[0];
    if (firstAnchor) {
      return {
        status: "judged",
        relevance: firstAnchor.relevance,
        matchType: "text_anchor_provisional",
      };
    }
  }

  // Multiple distinct anchors matched the same chunk content.
  // Never auto-merge, even if relevance scores are identical!
  return {
    status: "ambiguous",
    reason: `Multiple distinct anchor judgments (${anchorMatches.length}) matched the same chunk`,
    matchingJudgmentCount: anchorMatches.length,
  };
}

// ---------------------------------------------------------------------------
// Conversion to MetricCalculator ItemJudgment
// ---------------------------------------------------------------------------

/**
 * Maps a JudgmentResolution to MetricCalculator's ItemJudgment.
 *
 * - Explicit relevance 0, 1, 2 $\to$ `{ status: "judged", relevance }`.
 * - Unjudged and Ambiguous $\to$ `{ status: "unjudged" }`.
 *
 * This preserves explicit relevance 0 while preventing unjudged or ambiguous
 * candidates from contributing gain in DCG or hits in Recall.
 */
export function toItemJudgment(resolution: JudgmentResolution): ItemJudgment {
  if (resolution.status === "judged") {
    return {
      status: "judged",
      relevance: resolution.relevance,
    };
  }
  return {
    status: "unjudged",
  };
}

// ---------------------------------------------------------------------------
// Incompleteness Flags Determination
// ---------------------------------------------------------------------------

/**
 * Determines whether candidate pool evaluation metrics are complete or provisional.
 *
 * Rules:
 * - unjudgedInEvalPool: true if any candidate has status !== "judged".
 * - incompleteSources: true ONLY when expectedPoolingSources is explicitly defined
 *   AND one or more expected sources are missing from completedPoolingSources.
 *   Never inferred from an absent optional metadata field.
 * - pendingReview: true if any candidate was matched via text_anchor_provisional
 *   or resolved as ambiguous.
 */
export function determineIncompletenessFlags(
  candidatePool: readonly CandidateChunk[],
  poolMetadata?: JudgmentPoolMetadata | undefined,
): IncompletenessFlags {
  const unjudgedInEvalPool = candidatePool.some(
    (c) => c.judgment.status !== "judged",
  );

  let incompleteSources = false;
  if (poolMetadata?.expectedPoolingSources !== undefined) {
    const completedSet = new Set(poolMetadata.completedPoolingSources);
    incompleteSources = poolMetadata.expectedPoolingSources.some(
      (source) => !completedSet.has(source),
    );
  }

  const pendingReview = candidatePool.some(
    (c) =>
      c.judgment.status === "ambiguous" ||
      (c.judgment.status === "judged" &&
        c.judgment.matchType === "text_anchor_provisional"),
  );

  return {
    unjudgedInEvalPool,
    incompleteSources,
    pendingReview,
  };
}

// ---------------------------------------------------------------------------
// Candidate Pool Batch Matching
// ---------------------------------------------------------------------------

export interface CandidatePoolMatchResult {
  /** Candidate chunks with 1-indexed RRF ranks, scores, and resolutions. */
  readonly candidatePool: readonly CandidateChunk[];
  /** ItemJudgments mapped for MetricCalculator. */
  readonly itemJudgments: readonly ItemJudgment[];
  /** All judged relevances from the query judgment pool (for IDCG). */
  readonly allJudgmentRelevances: readonly (0 | 1 | 2)[];
  /** Count of chunks with confirmed human judgments (including explicit 0). */
  readonly judgedCount: number;
  /** Count of unjudged chunks. */
  readonly unjudgedCount: number;
  /** Count of ambiguous chunks. */
  readonly ambiguousCount: number;
  /** True if any candidate is unjudged or ambiguous. */
  readonly hasUnresolvedCandidates: boolean;
  /** True if any candidate was matched via provisional text anchor. */
  readonly hasProvisionalMatches: boolean;
  /** Incompleteness flags documenting query status. */
  readonly incompletenessFlags: IncompletenessFlags;
  /** Total relevant in judgment pool at lenient threshold (rel >= 1). */
  readonly totalRelevantLenient: number;
  /** Total relevant in judgment pool at strict threshold (rel == 2). */
  readonly totalRelevantStrict: number;
}

/**
 * Matches an entire candidate pool retrieved from HybridSearch against judgments.
 *
 * @param retrievedChunks Retrieved database chunks (ordered by RRF score descending).
 * @param judgments Ground truth judgments for this evaluation query.
 * @param poolMetadata Optional pooling metadata documenting source completion.
 */
export function matchCandidatePool(
  retrievedChunks: readonly RetrievedChunk[],
  judgments: readonly EvaluationJudgment[],
  poolMetadata?: JudgmentPoolMetadata | undefined,
): CandidatePoolMatchResult {
  const candidatePool: CandidateChunk[] = [];
  const itemJudgments: ItemJudgment[] = [];

  let judgedCount = 0;
  let unjudgedCount = 0;
  let ambiguousCount = 0;
  let hasProvisionalMatches = false;

  for (const [i, chunk] of retrievedChunks.entries()) {
    const resolution = matchCandidate(chunk, judgments);
    const itemJudg = toItemJudgment(resolution);

    candidatePool.push({
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      documentTitle: chunk.documentTitle,
      chunkIndex: chunk.chunkIndex,
      rrfRank: i + 1,
      rrfScore: chunk.similarity,
      judgment: resolution,
    });

    itemJudgments.push(itemJudg);

    if (resolution.status === "judged") {
      judgedCount++;
      if (resolution.matchType === "text_anchor_provisional") {
        hasProvisionalMatches = true;
      }
    } else if (resolution.status === "unjudged") {
      unjudgedCount++;
    } else if (resolution.status === "ambiguous") {
      ambiguousCount++;
    }
  }

  const allJudgmentRelevances = judgments.map((j) => j.relevance);
  const totalRelevantLenient = judgments.filter((j) => j.relevance >= 1).length;
  const totalRelevantStrict = judgments.filter((j) => j.relevance === 2).length;

  const hasUnresolvedCandidates = unjudgedCount > 0 || ambiguousCount > 0;
  const incompletenessFlags = determineIncompletenessFlags(
    candidatePool,
    poolMetadata,
  );

  return {
    candidatePool,
    itemJudgments,
    allJudgmentRelevances,
    judgedCount,
    unjudgedCount,
    ambiguousCount,
    hasUnresolvedCandidates,
    hasProvisionalMatches,
    incompletenessFlags,
    totalRelevantLenient,
    totalRelevantStrict,
  };
}

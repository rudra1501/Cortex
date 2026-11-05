/**
 * CandidatePoolCache — persistence, multi-tier fingerprinting, and replay
 * adapters for offline IR evaluation candidate pools and reranker outputs.
 *
 * Distinct Replay Modes:
 * 1. Candidate-pool replay with live reranking:
 *    Loads candidate pool from cache, skips embedding and Postgres retrieval,
 *    invokes Gemini reranker (consumes Gemini API tokens).
 * 2. Cached-ranking replay:
 *    Loads candidate pool AND recorded reranker outputs from cache, skips
 *    Gemini entirely (zero Gemini API calls, zero tokens consumed).
 *
 * Strict Security & Integrity:
 * - Atomic file I/O via temporary file and rename.
 * - Multi-tier fingerprinting: normalized query text (SHA-256), dataset (SHA-256),
 *   and corpus/document collection (SHA-256).
 * - Exact candidate metadata & score preservation (RRF vs cosine vs FTS).
 * - Zero user IDs or credentials stored in the cache.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";

import type { RetrievedChunk } from "../../retrieval/infrastructure/PgVectorRepository.js";
import type {
  RetrievalInput,
  RetrievalStrategy,
} from "../../retrieval/application/RetrievalStrategy.js";
import type { GeminiRerankResult } from "../../retrieval/application/GeminiReranker.js";
import type { EvaluatorReranker } from "../application/EvaluationRunner.js";
import type { EvaluationDataset } from "../domain/EvaluationDataset.js";
import type { RerankerTelemetry } from "../domain/EvaluationResult.js";
import { normalizeText } from "../application/CandidateMatcher.js";

// ---------------------------------------------------------------------------
// Schemas & Types
// ---------------------------------------------------------------------------

export const cachedCandidateChunkSchema = z
  .object({
    chunkId: z.string().min(1, "chunkId cannot be empty"),
    documentId: z.string().min(1, "documentId cannot be empty"),
    documentTitle: z.string().min(1, "documentTitle cannot be empty"),
    chunkIndex: z.number().int().nonnegative(),
    content: z.string(),
    /** Score value returned by retrieval (RRF score, cosine similarity, or FTS rank). */
    score: z.number(),
    /** Explicit semantic type of the retrieval score. */
    scoreType: z.enum(["rrf", "cosine_similarity", "fts_score"]),
    /** 1-indexed retrieval order in the candidate pool. */
    rank: z.number().int().positive(),
  })
  .strict();

export const cachedQueryPoolSchema = z
  .object({
    queryId: z.string().min(1, "queryId cannot be empty"),
    /** SHA-256 hash of normalized question text. */
    queryFingerprint: z.string().min(1, "queryFingerprint cannot be empty"),
    /** Original candidates in retrieval order. */
    chunks: z.array(cachedCandidateChunkSchema),
    /** Optional recorded reranking output for zero-token cached-ranking replay. */
    recordedRerank: z
      .object({
        chunks: z.array(cachedCandidateChunkSchema),
        telemetry: z
          .object({
            latencyMs: z.number().nonnegative(),
            status: z.enum(["success", "fallback", "skipped"]),
            failureType: z.string().optional(),
            httpStatus: z.number().optional(),
            approxTokens: z.number().optional(),
          })
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const candidatePoolCacheHeaderSchema = z
  .object({
    cacheVersion: z.literal("1.1.0"),
    datasetVersion: z.string().min(1),
    datasetFingerprint: z.string().min(1),
    corpusFingerprint: z.string().min(1),
    candidatePoolFingerprint: z.string().min(1).optional(),
    retrievalStrategy: z.enum(["HYBRID", "VECTOR", "FTS"]),
    rrfK: z.number().int().positive(),
    candidateK: z.number().int().positive(),
    similarityThreshold: z.number(),
    embeddingModel: z.string().min(1),
    rerankerModel: z.string().nullable().optional(),
    rerankerPromptVersion: z.string().nullable().optional(),
    recordedAt: z.string(),
    queryCount: z.number().int().nonnegative(),
  })
  .strict();

export const candidatePoolCacheSchema = z
  .object({
    header: candidatePoolCacheHeaderSchema,
    pools: z.array(cachedQueryPoolSchema),
  })
  .strict();

export type CachedCandidateChunk = z.infer<typeof cachedCandidateChunkSchema>;
export type CachedQueryPool = z.infer<typeof cachedQueryPoolSchema>;
export type CandidatePoolCacheHeader = z.infer<typeof candidatePoolCacheHeaderSchema>;
export type CandidatePoolCacheData = z.infer<typeof candidatePoolCacheSchema>;

// ---------------------------------------------------------------------------
// Custom Errors
// ---------------------------------------------------------------------------

export class CacheIncompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CacheIncompatibilityError";
  }
}

// ---------------------------------------------------------------------------
// Fingerprinting Functions
// ---------------------------------------------------------------------------

/**
 * Computes a deterministic SHA-256 fingerprint over normalized query text.
 */
export function computeQueryFingerprint(question: string): string {
  const normalized = normalizeText(question).toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

/**
 * Computes a deterministic SHA-256 fingerprint over an entire EvaluationDataset.
 * Covers sorted query IDs, normalized question texts, and all ground-truth judgments.
 */
export function computeDatasetFingerprint(dataset: EvaluationDataset): string {
  const sortedQueries = [...dataset.queries].sort((a, b) => a.id.localeCompare(b.id));

  const components: string[] = [];
  for (const q of sortedQueries) {
    const qFp = computeQueryFingerprint(q.question);
    components.push(`q:${q.id}|fp:${qFp}`);

    const sortedJudgments = [...q.judgments].sort((a, b) => {
      const docCmp = a.documentId.localeCompare(b.documentId);
      if (docCmp !== 0) return docCmp;
      const chunkCmp = (a.chunkId ?? "").localeCompare(b.chunkId ?? "");
      if (chunkCmp !== 0) return chunkCmp;
      return a.relevance - b.relevance;
    });

    for (const j of sortedJudgments) {
      const anchorFp = computeQueryFingerprint(j.textAnchor);
      components.push(`j:${j.documentId}:${j.chunkId ?? ""}:${j.relevance}:${anchorFp}`);
    }
  }

  return createHash("sha256").update(components.join("\n")).digest("hex").slice(0, 32);
}

export interface CorpusChunkInput {
  readonly id: string;
  readonly chunkIndex: number;
  readonly content: string;
}

export interface CorpusDocumentInput {
  readonly id: string;
  readonly updatedAt?: Date | string | undefined;
  readonly processedAt?: Date | string | null | undefined;
  readonly chunks?: readonly CorpusChunkInput[] | undefined;
}

export type CorpusFingerprintItem = string | CorpusDocumentInput;

/**
 * Computes a deterministic SHA-256 fingerprint over a document corpus collection.
 *
 * Accounts for documents being added, deleted, updated, or reprocessed, as well
 * as chunk additions, deletions, re-indexing, and full content modifications.
 *
 * Uses deterministic serialization and SHA-256 content hashing. Never puts raw
 * document content or credentials into fingerprint metadata or logs.
 */
export function computeCorpusFingerprint(
  items: readonly CorpusFingerprintItem[],
): string {
  const docMap = new Map<string, CorpusDocumentInput>();
  for (const item of items) {
    const doc: CorpusDocumentInput = typeof item === "string" ? { id: item } : item;
    const existing = docMap.get(doc.id);
    if (!existing) {
      docMap.set(doc.id, doc);
    } else {
      docMap.set(doc.id, {
        id: doc.id,
        updatedAt: doc.updatedAt ?? existing.updatedAt,
        processedAt: doc.processedAt ?? existing.processedAt,
        chunks: doc.chunks ?? existing.chunks,
      });
    }
  }

  const sortedDocs = Array.from(docMap.values()).sort((a, b) => a.id.localeCompare(b.id));

  const lines: string[] = [];
  for (const doc of sortedDocs) {
    const updatedStr = doc.updatedAt
      ? doc.updatedAt instanceof Date
        ? doc.updatedAt.toISOString()
        : String(doc.updatedAt)
      : "";
    const processedStr = doc.processedAt
      ? doc.processedAt instanceof Date
        ? doc.processedAt.toISOString()
        : String(doc.processedAt)
      : "";

    let chunksToken = "";
    if (doc.chunks && doc.chunks.length > 0) {
      const chunkMap = new Map<string, CorpusChunkInput>();
      for (const c of doc.chunks) {
        chunkMap.set(c.id, c);
      }
      const sortedChunks = Array.from(chunkMap.values()).sort(
        (a, b) => a.chunkIndex - b.chunkIndex || a.id.localeCompare(b.id),
      );
      const chunkParts = sortedChunks.map((c) => {
        // Hash the entire normalized content with SHA-256
        const contentHash = createHash("sha256")
          .update(normalizeText(c.content))
          .digest("hex");
        return `${c.id}:${c.chunkIndex}:${contentHash}`;
      });
      chunksToken = chunkParts.join(",");
    }

    lines.push(`doc:${doc.id}|up:${updatedStr}|pr:${processedStr}|chunks:[${chunksToken}]`);
  }

  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 32);
}

/**
 * Computes a deterministic SHA-256 fingerprint over the complete candidate pool
 * across all queries, preserving full candidate ordering, IDs, scores, and ranks.
 */
export function computeCandidatePoolFingerprint(pools: readonly CachedQueryPool[]): string {
  const sortedPools = [...pools].sort((a, b) => a.queryId.localeCompare(b.queryId));
  const lines: string[] = [];
  for (const pool of sortedPools) {
    const chunkTokens = pool.chunks.map(
      (c) => `${c.chunkId}:${c.rank}:${c.score}:${c.scoreType}`,
    );
    lines.push(`pool:${pool.queryId}:${chunkTokens.join(",")}`);
  }
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Query Identification via Evaluation Request ID
// ---------------------------------------------------------------------------

/**
 * Unambiguously extracts the query ID from an evaluation request ID.
 * Supports:
 * - `eval_<queryId>_<timestamp>`
 * - `eval::<encodedQueryId>::<timestamp>`
 */
export function parseEvalQueryId(requestId?: string): string | null {
  if (!requestId) return null;
  if (requestId.startsWith("eval::")) {
    const parts = requestId.split("::");
    return parts[1] ? decodeURIComponent(parts[1]) : null;
  }
  const match = requestId.match(/^eval_(.+)_\d+$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

// ---------------------------------------------------------------------------
// Candidate Reconstruction
// ---------------------------------------------------------------------------

/**
 * Faithfully reconstructs a RetrievedChunk from a CachedCandidateChunk.
 */
export function toRetrievedChunk(cached: CachedCandidateChunk): RetrievedChunk {
  return {
    chunkId: cached.chunkId,
    documentId: cached.documentId,
    documentTitle: cached.documentTitle,
    chunkIndex: cached.chunkIndex,
    content: cached.content,
    similarity: cached.score,
  };
}

/**
 * Converts a live RetrievedChunk to a CachedCandidateChunk.
 */
export function toCachedCandidateChunk(
  chunk: RetrievedChunk,
  rank: number,
  strategy: "HYBRID" | "VECTOR" | "FTS",
): CachedCandidateChunk {
  let scoreType: "rrf" | "cosine_similarity" | "fts_score" = "rrf";
  if (strategy === "VECTOR") scoreType = "cosine_similarity";
  else if (strategy === "FTS") scoreType = "fts_score";

  return {
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    chunkIndex: chunk.chunkIndex,
    content: chunk.content,
    score: chunk.similarity,
    scoreType,
    rank,
  };
}

// ---------------------------------------------------------------------------
// Cache Compatibility Validation
// ---------------------------------------------------------------------------

export interface RequiredQueryItem {
  readonly id: string;
  readonly question: string;
}

export interface CacheCompatibilityCriteria {
  readonly datasetVersion: string;
  readonly datasetFingerprint: string;
  readonly expectedCorpusFingerprint?: string | undefined;
  readonly expectedCandidatePoolFingerprint?: string | undefined;
  readonly retrievalStrategy: "HYBRID" | "VECTOR" | "FTS";
  readonly rrfK: number;
  readonly candidateK: number;
  readonly similarityThreshold: number;
  readonly embeddingModel: string;
  readonly expectedRerankerModel?: string | undefined;
  readonly expectedRerankerPromptVersion?: string | undefined;
  readonly requiredQueries: readonly RequiredQueryItem[];
  readonly requireRecordedRerank?: boolean | undefined;
}

/**
 * Validates that candidate pool cache data is strictly compatible with the
 * requested run options. Throws CacheIncompatibilityError immediately if any
 * invariant is violated.
 */
export function validateCacheCompatibility(
  cache: CandidatePoolCacheData,
  criteria: CacheCompatibilityCriteria,
): void {
  if (cache.header.cacheVersion !== "1.1.0") {
    throw new CacheIncompatibilityError(
      `Unsupported cache version "${cache.header.cacheVersion}". Expected "1.1.0".`,
    );
  }

  if (cache.header.datasetVersion !== criteria.datasetVersion) {
    throw new CacheIncompatibilityError(
      `Dataset version mismatch: cache has "${cache.header.datasetVersion}", expected "${criteria.datasetVersion}".`,
    );
  }

  if (cache.header.datasetFingerprint !== criteria.datasetFingerprint) {
    throw new CacheIncompatibilityError(
      `Dataset fingerprint mismatch: dataset questions or judgments have changed since cache was recorded.`,
    );
  }

  if (
    criteria.expectedCorpusFingerprint !== undefined &&
    cache.header.corpusFingerprint !== criteria.expectedCorpusFingerprint
  ) {
    throw new CacheIncompatibilityError(
      `Corpus fingerprint mismatch: cache was recorded against a different document corpus.`,
    );
  }

  if (cache.header.candidatePoolFingerprint !== undefined) {
    const computedPoolFp = computeCandidatePoolFingerprint(cache.pools);
    if (cache.header.candidatePoolFingerprint !== computedPoolFp) {
      throw new CacheIncompatibilityError(
        `Corrupt cache: candidatePoolFingerprint header does not match candidate pools data.`,
      );
    }
  }

  if (
    criteria.expectedCandidatePoolFingerprint !== undefined &&
    cache.header.candidatePoolFingerprint !== undefined &&
    cache.header.candidatePoolFingerprint !== criteria.expectedCandidatePoolFingerprint
  ) {
    throw new CacheIncompatibilityError(
      `Candidate pool fingerprint mismatch: cache candidate pool does not match expected snapshot.`,
    );
  }

  if (cache.header.retrievalStrategy !== criteria.retrievalStrategy) {
    throw new CacheIncompatibilityError(
      `Retrieval strategy mismatch: cache has "${cache.header.retrievalStrategy}", expected "${criteria.retrievalStrategy}".`,
    );
  }

  if (cache.header.rrfK !== criteria.rrfK) {
    throw new CacheIncompatibilityError(
      `RRF_K mismatch: cache has ${cache.header.rrfK}, expected ${criteria.rrfK}.`,
    );
  }

  if (cache.header.similarityThreshold !== criteria.similarityThreshold) {
    throw new CacheIncompatibilityError(
      `Similarity threshold mismatch: cache has ${cache.header.similarityThreshold}, expected ${criteria.similarityThreshold}.`,
    );
  }

  if (cache.header.embeddingModel !== criteria.embeddingModel) {
    throw new CacheIncompatibilityError(
      `Embedding model mismatch: cache has "${cache.header.embeddingModel}", expected "${criteria.embeddingModel}".`,
    );
  }

  if (cache.header.candidateK < criteria.candidateK) {
    throw new CacheIncompatibilityError(
      `Candidate pool limit incompatibility: cache has candidateK=${cache.header.candidateK}, but run requires candidateK=${criteria.candidateK}.`,
    );
  }

  if (
    criteria.expectedRerankerModel !== undefined &&
    cache.header.rerankerModel !== undefined &&
    cache.header.rerankerModel !== criteria.expectedRerankerModel
  ) {
    throw new CacheIncompatibilityError(
      `Reranker model mismatch: cache recorded with "${cache.header.rerankerModel ?? "none"}", expected "${criteria.expectedRerankerModel}".`,
    );
  }

  if (
    criteria.expectedRerankerPromptVersion !== undefined &&
    cache.header.rerankerPromptVersion !== undefined &&
    cache.header.rerankerPromptVersion !== criteria.expectedRerankerPromptVersion
  ) {
    throw new CacheIncompatibilityError(
      `Reranker prompt version mismatch: cache recorded with "${cache.header.rerankerPromptVersion ?? "none"}", expected "${criteria.expectedRerankerPromptVersion}".`,
    );
  }

  // Validate query coverage and per-query question text fingerprints
  const poolMap = new Map<string, CachedQueryPool>();
  for (const pool of cache.pools) {
    poolMap.set(pool.queryId, pool);
  }

  for (const q of criteria.requiredQueries) {
    const pool = poolMap.get(q.id);
    if (!pool) {
      throw new CacheIncompatibilityError(
        `Cache is missing candidate pool for query ID "${q.id}".`,
      );
    }

    const currentFp = computeQueryFingerprint(q.question);
    if (pool.queryFingerprint !== currentFp) {
      throw new CacheIncompatibilityError(
        `Query text mismatch for query ID "${q.id}". Candidate pool was recorded with different question text (cached fingerprint "${pool.queryFingerprint}", expected "${currentFp}").`,
      );
    }

    if (criteria.requireRecordedRerank) {
      if (!pool.recordedRerank) {
        throw new CacheIncompatibilityError(
          `Cache missing recorded reranker output for query ID "${q.id}".`,
        );
      }

      // Permutation validation: verify recordedRerank is a complete permutation of candidate chunks
      if (pool.recordedRerank.chunks.length !== pool.chunks.length) {
        throw new CacheIncompatibilityError(
          `Recorded rerank for query ID "${q.id}" length mismatch (${pool.recordedRerank.chunks.length} vs expected ${pool.chunks.length}).`,
        );
      }

      const originalIds = new Set(pool.chunks.map((c) => c.chunkId));
      const seenIds = new Set<string>();

      for (const chunk of pool.recordedRerank.chunks) {
        if (!originalIds.has(chunk.chunkId)) {
          throw new CacheIncompatibilityError(
            `Recorded rerank for query ID "${q.id}" contains unexpected chunkId "${chunk.chunkId}".`,
          );
        }
        if (seenIds.has(chunk.chunkId)) {
          throw new CacheIncompatibilityError(
            `Recorded rerank for query ID "${q.id}" contains duplicate chunkId "${chunk.chunkId}".`,
          );
        }
        seenIds.add(chunk.chunkId);
      }

      if (seenIds.size !== pool.chunks.length) {
        throw new CacheIncompatibilityError(
          `Recorded rerank for query ID "${q.id}" is an incomplete permutation of the candidate pool.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Replay Adapters
// ---------------------------------------------------------------------------

/**
 * ReplayRetrievalStrategy: Replays candidate pools directly from cache,
 * skipping query embedding and PostgreSQL retrieval.
 */
export class ReplayRetrievalStrategy implements RetrievalStrategy {
  private readonly poolMap = new Map<string, CachedQueryPool>();

  constructor(
    pools: readonly CachedQueryPool[],
    private readonly queryIdExtractor: (input: RetrievalInput) => string | null = (input) =>
      parseEvalQueryId(input.requestId),
  ) {
    for (const pool of pools) {
      this.poolMap.set(pool.queryId, pool);
    }
  }

  async execute(input: RetrievalInput): Promise<RetrievedChunk[]> {
    const queryId = this.queryIdExtractor(input);
    if (!queryId) {
      throw new Error(
        `ReplayRetrievalStrategy: unable to extract evaluation queryId from requestId "${input.requestId ?? ""}"`,
      );
    }

    const pool = this.poolMap.get(queryId);
    if (!pool) {
      throw new Error(
        `ReplayRetrievalStrategy: no cached candidate pool found for query ID "${queryId}"`,
      );
    }

    // Verify question fingerprint without logging full question text
    const currentFp = computeQueryFingerprint(input.query);
    if (pool.queryFingerprint !== currentFp) {
      throw new Error(
        `ReplayRetrievalStrategy: query text mismatch for query ID "${queryId}" ` +
          `(cached fingerprint "${pool.queryFingerprint}", received "${currentFp}").`,
      );
    }

    // Return chunks sliced to requested candidate limit
    return pool.chunks.slice(0, input.limit).map(toRetrievedChunk);
  }
}

/**
 * ReplayReranker: Replays previously recorded Gemini reranker output,
 * skipping Gemini API calls entirely (zero tokens consumed).
 */
export class ReplayReranker implements EvaluatorReranker {
  private readonly rerankMap = new Map<
    string,
    {
      readonly chunks: readonly CachedCandidateChunk[];
      readonly telemetry: RerankerTelemetry;
    }
  >();

  constructor(
    pools: readonly CachedQueryPool[],
    private readonly queryIdExtractor: (requestId?: string) => string | null = parseEvalQueryId,
  ) {
    for (const pool of pools) {
      if (pool.recordedRerank) {
        this.rerankMap.set(pool.queryId, pool.recordedRerank);
      }
    }
  }

  async rerankWithTelemetry(
    _query: string,
    _candidates: RetrievedChunk[],
    requestId?: string,
  ): Promise<GeminiRerankResult> {
    const queryId = this.queryIdExtractor(requestId);
    if (!queryId) {
      throw new Error(
        `ReplayReranker: unable to extract evaluation queryId from requestId "${requestId ?? ""}"`,
      );
    }

    const recorded = this.rerankMap.get(queryId);
    if (!recorded) {
      throw new Error(
        `ReplayReranker: no recorded reranker output found for query ID "${queryId}"`,
      );
    }

    const chunks = recorded.chunks.map(toRetrievedChunk);

    return {
      chunks,
      telemetry: {
        latencyMs: recorded.telemetry.latencyMs,
        status: recorded.telemetry.status,
        ...(recorded.telemetry.failureType !== undefined
          ? { failureType: recorded.telemetry.failureType as any }
          : {}),
        ...(recorded.telemetry.approxTokens !== undefined
          ? { approxTokens: recorded.telemetry.approxTokens }
          : {}),
      },
    };
  }

  async rerank(
    query: string,
    candidates: RetrievedChunk[],
    requestId?: string,
  ): Promise<RetrievedChunk[]> {
    const res = await this.rerankWithTelemetry(query, candidates, requestId);
    return res.chunks;
  }
}

// ---------------------------------------------------------------------------
// Atomic Disk I/O
// ---------------------------------------------------------------------------

/**
 * Atomically writes CandidatePoolCacheData to disk via temporary file and rename.
 */
export async function saveCache(
  filePath: string,
  data: CandidatePoolCacheData,
): Promise<void> {
  // Validate schema before writing
  const validated = candidatePoolCacheSchema.parse(data);
  const json = JSON.stringify(validated, null, 2);

  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    await fs.writeFile(tempPath, json, "utf-8");
    await fs.rename(tempPath, filePath);
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
}

/**
 * Loads and validates a candidate pool cache file from disk.
 * Throws explicit errors for corrupted JSON or missing schema fields.
 */
export async function loadCache(filePath: string): Promise<CandidatePoolCacheData> {
  const content = await fs.readFile(filePath, "utf-8");
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `Failed to parse cache file at "${filePath}": invalid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  return candidatePoolCacheSchema.parse(raw);
}

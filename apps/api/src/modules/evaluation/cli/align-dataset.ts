/**
 * align-dataset.ts — safe offline CLI utility to inspect and realign stale
 * chunk IDs in an evaluation dataset after document reprocessing.
 *
 * Guarantees:
 * - Dry-run by default (no files modified unless --write or --in-place specified).
 * - Exact documentId and userId scoping.
 * - Zero modification of human ground-truth relevance scores, text anchors, or annotations.
 * - Ambiguous or unmatched mappings remain unresolved.
 * - --in-place creates a dated .bak file before writing.
 * - --write and --in-place are strictly mutually exclusive.
 * - Atomic file writes via temporary file and rename.
 *
 * Usage:
 *   npx tsx src/modules/evaluation/cli/align-dataset.ts --dataset <path> --user-id <userId> [--write <path> | --in-place]
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

import type { EvaluationDataset, EvaluationJudgment } from "../domain/EvaluationDataset.js";
import {
  parseEvaluationDatasetJson,
  serializeEvaluationDataset,
} from "../domain/EvaluationDataset.js";
import { normalizeText } from "../application/CandidateMatcher.js";

// ---------------------------------------------------------------------------
// Types & Contracts
// ---------------------------------------------------------------------------

export type AlignmentStatus = "confirmed" | "realigned" | "ambiguous" | "unmatched";

export interface AlignedJudgmentRecord {
  readonly queryId: string;
  readonly documentId: string;
  readonly originalChunkId: string | undefined;
  readonly realignedChunkId: string | undefined;
  readonly originalChunkIndex: number | undefined;
  readonly realignedChunkIndex: number | undefined;
  readonly status: AlignmentStatus;
  readonly matchingCount: number;
}

export interface AlignmentSummary {
  readonly totalJudgments: number;
  readonly confirmed: number;
  readonly realigned: number;
  readonly ambiguous: number;
  readonly unmatched: number;
  readonly records: readonly AlignedJudgmentRecord[];
  readonly realignedDataset: EvaluationDataset;
}

export interface ChunkRecord {
  readonly id: string;
  readonly documentId: string;
  readonly chunkIndex: number;
  readonly content: string;
}

export interface ChunkProvider {
  findChunks(documentId: string, userId: string): Promise<readonly ChunkRecord[]>;
}

export interface AlignCliOptions {
  readonly datasetPath: string;
  readonly userId: string;
  readonly writePath?: string | undefined;
  readonly inPlace?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Pure Alignment Engine
// ---------------------------------------------------------------------------

/**
 * Realigns dataset chunk pointers using semantic text anchors.
 * Invariant: Never alters human ground-truth relevance labels!
 */
export async function alignDataset(
  dataset: EvaluationDataset,
  chunkProvider: ChunkProvider,
  userId: string,
): Promise<AlignmentSummary> {
  const records: AlignedJudgmentRecord[] = [];
  let confirmedCount = 0;
  let realignedCount = 0;
  let ambiguousCount = 0;
  let unmatchedCount = 0;

  // Deep clone queries & judgments to prepare realigned dataset
  const updatedQueries = await Promise.all(
    dataset.queries.map(async (query) => {
      const updatedJudgments: EvaluationJudgment[] = [];

      for (const judgment of query.judgments) {
        // Query chunks for this specific document and user only
        const chunks = await chunkProvider.findChunks(judgment.documentId, userId);
        const normalizedAnchor = normalizeText(judgment.textAnchor);

        // Check if existing pointer is still confirmed
        let confirmedChunk: ChunkRecord | undefined = undefined;
        if (judgment.chunkId) {
          const matchById = chunks.find((c) => c.id === judgment.chunkId);
          if (matchById && normalizeText(matchById.content).includes(normalizedAnchor)) {
            confirmedChunk = matchById;
          }
        }

        if (confirmedChunk) {
          confirmedCount++;
          records.push({
            queryId: query.id,
            documentId: judgment.documentId,
            originalChunkId: judgment.chunkId,
            realignedChunkId: judgment.chunkId,
            originalChunkIndex: judgment.chunkIndex,
            realignedChunkIndex: judgment.chunkIndex,
            status: "confirmed",
            matchingCount: 1,
          });
          // Preserve judgment as-is
          updatedJudgments.push({ ...judgment });
          continue;
        }

        // Pointer is missing or stale: search document chunks for unique anchor match
        const matchingChunks = chunks.filter((c) =>
          normalizeText(c.content).includes(normalizedAnchor),
        );

        if (matchingChunks.length === 1) {
          const matched = matchingChunks[0]!;
          realignedCount++;
          records.push({
            queryId: query.id,
            documentId: judgment.documentId,
            originalChunkId: judgment.chunkId,
            realignedChunkId: matched.id,
            originalChunkIndex: judgment.chunkIndex,
            realignedChunkIndex: matched.chunkIndex,
            status: "realigned",
            matchingCount: 1,
          });
          // Update pointer ONLY; preserve relevance, textAnchor, and notes intact!
          updatedJudgments.push({
            ...judgment,
            chunkId: matched.id,
            chunkIndex: matched.chunkIndex,
          });
        } else if (matchingChunks.length > 1) {
          ambiguousCount++;
          records.push({
            queryId: query.id,
            documentId: judgment.documentId,
            originalChunkId: judgment.chunkId,
            realignedChunkId: judgment.chunkId,
            originalChunkIndex: judgment.chunkIndex,
            realignedChunkIndex: judgment.chunkIndex,
            status: "ambiguous",
            matchingCount: matchingChunks.length,
          });
          // Ambiguous match remains unresolved
          updatedJudgments.push({ ...judgment });
        } else {
          unmatchedCount++;
          records.push({
            queryId: query.id,
            documentId: judgment.documentId,
            originalChunkId: judgment.chunkId,
            realignedChunkId: judgment.chunkId,
            originalChunkIndex: judgment.chunkIndex,
            realignedChunkIndex: judgment.chunkIndex,
            status: "unmatched",
            matchingCount: 0,
          });
          // Unmatched remains unresolved
          updatedJudgments.push({ ...judgment });
        }
      }

      return {
        ...query,
        judgments: updatedJudgments,
      };
    }),
  );

  const realignedDataset: EvaluationDataset = {
    ...dataset,
    queries: updatedQueries,
  };

  return {
    totalJudgments: records.length,
    confirmed: confirmedCount,
    realigned: realignedCount,
    ambiguous: ambiguousCount,
    unmatched: unmatchedCount,
    records,
    realignedDataset,
  };
}

// ---------------------------------------------------------------------------
// CLI Argument Validation
// ---------------------------------------------------------------------------

export function validateAlignCliArgs(options: {
  dataset?: string | undefined;
  "user-id"?: string | undefined;
  write?: string | undefined;
  "in-place"?: boolean | undefined;
}): { valid: true } | { valid: false; errors: string[] } {
  const errors: string[] = [];

  if (!options.dataset) {
    errors.push("Missing required argument: --dataset <path>");
  }

  if (!options["user-id"]) {
    errors.push("Missing required argument: --user-id <userId>");
  }

  if (options.write && options["in-place"]) {
    errors.push("Conflicting arguments: --write and --in-place are mutually exclusive. Choose one.");
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Atomic Dataset Saver
// ---------------------------------------------------------------------------

export async function saveDatasetAtomic(
  outputPath: string,
  dataset: EvaluationDataset,
): Promise<void> {
  const serialized = serializeEvaluationDataset(dataset);
  const dir = path.dirname(outputPath);
  await fs.mkdir(dir, { recursive: true });

  const tempPath = `${outputPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    await fs.writeFile(tempPath, serialized, "utf-8");
    await fs.rename(tempPath, outputPath);
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// CLI Execution
// ---------------------------------------------------------------------------

export async function runAlignCli(
  rawArgs: string[],
  deps?: { chunkProvider?: ChunkProvider },
): Promise<number> {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      dataset: { type: "string" },
      "user-id": { type: "string" },
      write: { type: "string" },
      "in-place": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`
Cortex Offline Dataset Alignment Utility

Usage:
  npx tsx src/modules/evaluation/cli/align-dataset.ts [options]

Required Options:
  --dataset <path>        Path to evaluation dataset JSON file
  --user-id <string>      User ID whose document chunks to query in database

Save Options (Mutually Exclusive):
  --write <path>          Save realigned dataset to a new JSON file
  --in-place              Overwrite original dataset in place (creates .bak first)

Modes:
  --dry-run               Dry run (default if neither --write nor --in-place is specified)
  --help                  Show this help message
`);
    return 0;
  }

  const validation = validateAlignCliArgs(values);
  if (!validation.valid) {
    for (const err of validation.errors) {
      console.error(`[ALIGN ERROR] ${err}`);
    }
    return 1;
  }

  const datasetPath = path.resolve(values.dataset!);
  const userId = values["user-id"]!;
  const isDryRun = Boolean(values["dry-run"] || (!values.write && !values["in-place"]));

  let content: string;
  try {
    content = await fs.readFile(datasetPath, "utf-8");
  } catch (err) {
    console.error(`[ALIGN ERROR] Failed to read dataset file at "${datasetPath}": ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  let dataset: EvaluationDataset;
  try {
    dataset = parseEvaluationDatasetJson(content);
  } catch (err) {
    console.error(`[ALIGN ERROR] Dataset schema validation failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // Resolve chunk provider: injected provider or Prisma
  let chunkProvider = deps?.chunkProvider;
  if (!chunkProvider) {
    const { prisma } = await import("../../../config/database.js");
    chunkProvider = {
      async findChunks(documentId: string, uId: string): Promise<readonly ChunkRecord[]> {
        const rows = await prisma.chunk.findMany({
          where: {
            documentId,
            document: { userId: uId },
          },
          select: {
            id: true,
            documentId: true,
            chunkIndex: true,
            content: true,
          },
        });
        return rows;
      },
    };
  }

  console.log(`[ALIGN] Scanning dataset "${dataset.version}" for user "${userId}"...`);
  const summary = await alignDataset(dataset, chunkProvider, userId);

  console.log("\n=== Realignment Summary ===");
  console.log(`Total Judgments Evaluated : ${summary.totalJudgments}`);
  console.log(`  Confirmed (unchanged)   : ${summary.confirmed}`);
  console.log(`  Realigned (refreshed)   : ${summary.realigned}`);
  console.log(`  Ambiguous (unresolved)  : ${summary.ambiguous}`);
  console.log(`  Unmatched (unresolved)  : ${summary.unmatched}`);
  console.log("===========================\n");

  if (isDryRun) {
    console.log("[ALIGN] Dry run mode (default). No files modified.");
    if (summary.realigned > 0) {
      console.log(`[ALIGN] Propose updating ${summary.realigned} stale chunk pointer(s). Use --write <path> or --in-place to save.`);
    }
    return 0;
  }

  if (values["in-place"]) {
    const backupPath = `${datasetPath}.bak.${Date.now()}`;
    await fs.copyFile(datasetPath, backupPath);
    console.log(`[ALIGN] Backup created at: ${backupPath}`);
    await saveDatasetAtomic(datasetPath, summary.realignedDataset);
    console.log(`[ALIGN] Dataset updated in-place: ${datasetPath}`);
    return 0;
  }

  if (values.write) {
    const writePath = path.resolve(values.write);
    await saveDatasetAtomic(writePath, summary.realignedDataset);
    console.log(`[ALIGN] Realigned dataset written to: ${writePath}`);
    return 0;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Entry Point Guard
// ---------------------------------------------------------------------------

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]).endsWith(path.join("cli", "align-dataset.ts"));

if (isMainModule) {
  runAlignCli(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      console.error("[ALIGN FATAL]", err);
      process.exit(1);
    });
}

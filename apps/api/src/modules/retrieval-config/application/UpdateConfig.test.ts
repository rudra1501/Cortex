/**
 * Unit tests for retrieval-config validation of the reranking settings.
 *
 * Covers the stateless Zod layer plus the stateful effective-value validation
 * in UpdateConfig (partial updates against the persisted row).
 *
 * Runner: Node.js built-in test runner. No database — the repository is faked.
 *
 * Run:  npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { UpdateConfig } from "./UpdateConfig.ts";
import {
  RERANK_CANDIDATE_K_MAX,
  updateConfigSchema,
} from "../presentation/retrieval-config.schema.ts";
import { RERANK_MAX_CANDIDATES } from "../../retrieval/application/GeminiReranker.ts";

import type { PrismaRetrievalConfigRepository } from "../infrastructure/prisma-retrieval-config.repository.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
type PersistedConfig = {
  id: string;
  userId: string;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  similarityThreshold: number;
  retrievalStrategy: "VECTOR" | "FTS" | "HYBRID";
  embeddingStrategy: "GEMINI";
  enableReranking: boolean;
  rerankCandidateK: number;
};

function persistedConfig(
  overrides: Partial<PersistedConfig> = {},
): PersistedConfig {
  return {
    id: "config-1",
    userId: "user-1",
    chunkSize: 1000,
    chunkOverlap: 200,
    topK: 5,
    similarityThreshold: 0.75,
    retrievalStrategy: "VECTOR",
    embeddingStrategy: "GEMINI",
    enableReranking: false,
    rerankCandidateK: 20,
    ...overrides,
  };
}

type UpdateCall = {
  id: string;
  data: Record<string, unknown>;
  expected?: {
    topK: number;
    rerankCandidateK: number;
    enableReranking: boolean;
  };
};

function fakeRepository(config: PersistedConfig | null, updateImpl?: () => never) {
  const calls: UpdateCall[] = [];

  const repository = {
    async findById() {
      return config;
    },

    async update(
      id: string,
      data: Record<string, unknown>,
      expected?: UpdateCall["expected"],
    ) {
      calls.push({ id, data, ...(expected !== undefined && { expected }) });

      if (updateImpl) {
        updateImpl();
      }

      return { ...(config ?? {}), ...data };
    },

    async create() {
      throw new Error("not used");
    },

    async findByUserId() {
      return config;
    },
  };

  return {
    calls,
    repository: repository as unknown as PrismaRetrievalConfigRepository,
  };
}

// ---------------------------------------------------------------------------
// CV-1: valid, reranking enabled with a large enough candidate pool
// ---------------------------------------------------------------------------
test("CV-1: topK=5, rerankCandidateK=20, reranking on is accepted", async () => {
  const { repository, calls } = fakeRepository(persistedConfig());

  const config = await new UpdateConfig(repository).execute({
    id: "config-1",
    userId: "user-1",
    topK: 5,
    rerankCandidateK: 20,
    enableReranking: true,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.data.topK, 5);
  assert.equal(calls[0]?.data.rerankCandidateK, 20);
  assert.equal(calls[0]?.data.enableReranking, true);
  assert.equal(config.enableReranking, true);
});

// ---------------------------------------------------------------------------
// CV-2: invalid, reranking enabled with candidateK < topK
// ---------------------------------------------------------------------------
test("CV-2: topK=10 with rerankCandidateK=5 and reranking on is rejected", async () => {
  const { repository, calls } = fakeRepository(persistedConfig());

  await assert.rejects(
    () =>
      new UpdateConfig(repository).execute({
        id: "config-1",
        userId: "user-1",
        topK: 10,
        rerankCandidateK: 5,
        enableReranking: true,
      }),
    /rerankCandidateK \(5\) must be >= topK \(10\) when reranking is enabled/,
  );

  assert.equal(calls.length, 0, "invalid config must not be written");
});

// ---------------------------------------------------------------------------
// CV-3: candidateK < topK is allowed while reranking is disabled
// ---------------------------------------------------------------------------
test("CV-3: candidateK < topK is accepted while reranking is disabled", async () => {
  const { repository, calls } = fakeRepository(persistedConfig());

  await new UpdateConfig(repository).execute({
    id: "config-1",
    userId: "user-1",
    topK: 10,
    rerankCandidateK: 5,
    enableReranking: false,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.data.rerankCandidateK, 5);
});

// ---------------------------------------------------------------------------
// CV-4: partial update raises topK above the persisted candidateK
// ---------------------------------------------------------------------------
test("CV-4: raising topK above the persisted rerankCandidateK is rejected", async () => {
  const { repository, calls } = fakeRepository(
    persistedConfig({ topK: 5, rerankCandidateK: 20, enableReranking: true }),
  );

  await assert.rejects(
    () =>
      new UpdateConfig(repository).execute({
        id: "config-1",
        userId: "user-1",
        topK: 25,
      }),
    /rerankCandidateK \(20\) must be >= topK \(25\)/,
  );

  assert.equal(calls.length, 0);
});

test("CV-4b: a matching partial topK update is accepted and validated against persisted values", async () => {
  const { repository, calls } = fakeRepository(
    persistedConfig({ topK: 5, rerankCandidateK: 20, enableReranking: true }),
  );

  await new UpdateConfig(repository).execute({
    id: "config-1",
    userId: "user-1",
    topK: 15,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.data.topK, 15);
  assert.deepEqual(calls[0]?.expected, {
    topK: 5,
    rerankCandidateK: 20,
    enableReranking: true,
  });
});

// ---------------------------------------------------------------------------
// CV-5: partial update enables reranking with an insufficient persisted pool
// ---------------------------------------------------------------------------
test("CV-5: enabling reranking with persisted topK > rerankCandidateK is rejected", async () => {
  const { repository, calls } = fakeRepository(
    persistedConfig({ topK: 25, rerankCandidateK: 20, enableReranking: false }),
  );

  await assert.rejects(
    () =>
      new UpdateConfig(repository).execute({
        id: "config-1",
        userId: "user-1",
        enableReranking: true,
      }),
    /rerankCandidateK \(20\) must be >= topK \(25\)/,
  );

  assert.equal(calls.length, 0);
});

test("CV-5b: enabling reranking with an equal persisted pool is accepted", async () => {
  const { repository, calls } = fakeRepository(
    persistedConfig({ topK: 20, rerankCandidateK: 20, enableReranking: false }),
  );

  await new UpdateConfig(repository).execute({
    id: "config-1",
    userId: "user-1",
    enableReranking: true,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.data.enableReranking, true);
});

// ---------------------------------------------------------------------------
// Ownership / missing config
// ---------------------------------------------------------------------------
test("CV-8: a config owned by another user is not updatable", async () => {
  const { repository, calls } = fakeRepository(persistedConfig({ userId: "other" }));

  await assert.rejects(
    () =>
      new UpdateConfig(repository).execute({
        id: "config-1",
        userId: "user-1",
        enableReranking: true,
      }),
    /Configuration not found/,
  );

  assert.equal(calls.length, 0);
});

test("CV-9: a concurrent modification surfaced by the repository is not swallowed", async () => {
  const { repository } = fakeRepository(persistedConfig(), () => {
    throw new Error("Configuration was modified concurrently, please retry");
  });

  await assert.rejects(
    () =>
      new UpdateConfig(repository).execute({
        id: "config-1",
        userId: "user-1",
        rerankCandidateK: 20,
      }),
    /modified concurrently/,
  );
});

// ---------------------------------------------------------------------------
// CV-6 / CV-7: Zod bounds on rerankCandidateK
// ---------------------------------------------------------------------------
test("CV-6: rerankCandidateK=100 is rejected by the request schema", () => {
  assert.throws(
    () => updateConfigSchema.parse({ rerankCandidateK: 100 }),
    /rerankCandidateK must be between 1 and 30/,
  );
});

test("CV-6b: the ceiling is the reranker candidate cap (31 rejected, 30 accepted)", () => {
  assert.throws(
    () => updateConfigSchema.parse({ rerankCandidateK: 31 }),
    /rerankCandidateK must be between 1 and 30/,
  );

  assert.equal(
    updateConfigSchema.parse({ rerankCandidateK: 30 }).rerankCandidateK,
    30,
  );
  assert.equal(RERANK_CANDIDATE_K_MAX, RERANK_MAX_CANDIDATES);
});

test("CV-7: rerankCandidateK=0 is rejected by the request schema", () => {
  assert.throws(
    () => updateConfigSchema.parse({ rerankCandidateK: 0 }),
    /rerankCandidateK must be between 1 and 30/,
  );
});

test("CV-10: the request schema accepts the reranking fields and keeps them optional", () => {
  assert.deepEqual(
    updateConfigSchema.parse({
      enableReranking: true,
      rerankCandidateK: RERANK_MAX_CANDIDATES,
    }),
    { enableReranking: true, rerankCandidateK: RERANK_MAX_CANDIDATES },
  );

  assert.deepEqual(updateConfigSchema.parse({}), {});

  assert.throws(() => updateConfigSchema.parse({ enableReranking: "yes" }));
  assert.throws(() => updateConfigSchema.parse({ rerankCandidateK: 2.5 }));
});

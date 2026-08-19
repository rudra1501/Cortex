-- CreateEnum
CREATE TYPE "EmbeddingStrategy" AS ENUM ('GEMINI');

-- CreateEnum
CREATE TYPE "RetrievalStrategy" AS ENUM ('VECTOR');

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "retrievalConfigId" TEXT;

-- CreateTable
CREATE TABLE "RetrievalConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chunkSize" INTEGER NOT NULL DEFAULT 1000,
    "chunkOverlap" INTEGER NOT NULL DEFAULT 200,
    "topK" INTEGER NOT NULL DEFAULT 5,
    "similarityThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.75,
    "embeddingStrategy" "EmbeddingStrategy" NOT NULL DEFAULT 'GEMINI',
    "retrievalStrategy" "RetrievalStrategy" NOT NULL DEFAULT 'VECTOR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RetrievalConfig_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_retrievalConfigId_fkey" FOREIGN KEY ("retrievalConfigId") REFERENCES "RetrievalConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetrievalConfig" ADD CONSTRAINT "RetrievalConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "RetrievalConfig" ADD COLUMN     "enableReranking" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rerankCandidateK" INTEGER NOT NULL DEFAULT 20;

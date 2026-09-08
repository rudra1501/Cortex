import type { RetrievalStrategy } from "../../application/RetrievalStrategy.js";
import { VectorSearch } from "../../application/VectorSearch.js";
import { PgVectorRepository } from "../PgVectorRepository.js";

export function getRetrievalStrategy(strategy: string): RetrievalStrategy {
  switch (strategy) {
    case "VECTOR":
      return new VectorSearch(new PgVectorRepository());

    default:
      throw new Error(`Unsupported retrieval strategy: ${strategy}`);
  }
}

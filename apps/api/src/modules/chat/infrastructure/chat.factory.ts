import { GenerateResponse } from "../application/GenerateResponse.js";

import { GeminiGenerationStrategy } from "./strategies/GeminiGenerationStrategy.js";

export function createGenerateResponseUseCase() {
  return new GenerateResponse(
    new GeminiGenerationStrategy(),
  );
}
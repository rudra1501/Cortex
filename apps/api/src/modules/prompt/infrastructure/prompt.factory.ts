import { BuildPrompt } from "../application/BuildPrompt.js";

export function createBuildPromptUseCase() {
  return new BuildPrompt();
}
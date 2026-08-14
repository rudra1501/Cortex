export interface GenerationStrategy {
  generate(prompt: string): Promise<string>;
}
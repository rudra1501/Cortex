export interface GenerationStrategy {
  generate(
    prompt: string,
  ): Promise<string>;

  generateStream(
    prompt: string,
  ): AsyncGenerator<string>;
}
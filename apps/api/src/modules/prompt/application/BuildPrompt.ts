type BuildPromptInput = {
  question: string;
  context: string;
};

export class BuildPrompt {
  execute({ question, context }: BuildPromptInput): string {
    return `
You are an AI assistant.

Answer the user's question using ONLY the provided context.

If the answer cannot be found in the context, say:

"I couldn't find that information in your documents."

Context:

${context}

Question:

${question}

Answer:
`.trim();
  }
}

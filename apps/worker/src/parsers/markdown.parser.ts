import type { DocumentParser } from "./parser.js";

export class MarkdownParser implements DocumentParser {
  async parse(buffer: Buffer): Promise<string> {
    return buffer.toString("utf-8");
  }
}
import { PDFParse } from "pdf-parse";
import type { DocumentParser } from "./parser.js";

export class PdfParser implements DocumentParser {
  async parse(buffer: Buffer): Promise<string> {
    const parser = new PDFParse({
      data: buffer,
    });

    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }
}
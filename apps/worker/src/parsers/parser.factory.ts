import { PdfParser } from "./pdf.parser.js";
import { MarkdownParser } from "./markdown.parser.js";
import type { DocumentParser } from "./parser.js";

const pdfParser = new PdfParser();
const markdownParser = new MarkdownParser();

export function getParser(
  mimeType: string,
): DocumentParser {
  switch (mimeType) {
    case "application/pdf":
      return pdfParser;

    case "text/markdown":
    case "text/plain":
      return markdownParser;

    default:
      throw new Error(
        `Unsupported MIME type: ${mimeType}`,
      );
  }
}
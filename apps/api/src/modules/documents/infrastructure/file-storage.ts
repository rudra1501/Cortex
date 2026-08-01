import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

export class FileStorage {
  private readonly uploadDir = process.env.UPLOAD_DIR ?? "uploads";

  async save(file: {
    filename: string;
    mimetype: string;
    buffer: Buffer;
  }) {
    await mkdir(this.uploadDir, { recursive: true });

    const extension = file.filename.split(".").pop();
    const fileName = `${randomUUID()}.${extension}`;

    const storagePath = resolve(this.uploadDir, fileName);

    await writeFile(storagePath, file.buffer);

    return storagePath;
  }
}
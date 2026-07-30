import { documentQueue } from "./document.queue.js";

export class DocumentQueueService {
 async enqueue(documentId: string) {

  await documentQueue.add("ingest-document", {
    documentId,
  });

}
}
import Fastify from "fastify";
import "dotenv/config";
import "./workers/document.worker.js";

// import type { EmbeddingStrategy } from "./embeddings/EmbeddingStrategy.js";
// import { EmbeddingService } from "./embeddings/embedding.service.js";

// const strategy: EmbeddingStrategy =
//   new EmbeddingService();

// const embedding =
//   await strategy.generateEmbedding(
//     "Hello world",
//   );

// console.log(
//   "Embedding dimensions:",
//   embedding.length,
// );


const app = Fastify({
  logger: true,
});

app.get("/health", async () => {
  return {
    status: "worker ok",
  };
});

const start = async () => {
  try {
    await app.listen({
      port: 3002,
      host: "0.0.0.0",
    });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
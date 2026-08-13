import Fastify from "fastify";
import jwtPlugin from "./plugins/jwt.js";
import authRoutes from "./modules/auth/presentation/auth.routes.js";
import authenticatePlugin from "./plugins/authenticate.js";
import documentRoutes from "./modules/documents/presentation/document.routes.js";
import { DocumentQueueService } from "./modules/documents/infrastructure/document-queue.service.js";
import multipart from "@fastify/multipart";
import {
  createContextBuilderUseCase,
  createEmbedQueryUseCase,
  createVectorSearchUseCase,
} from "./modules/retrieval/infrastructure/retrieval.factory.js";

const app = Fastify({
  logger: true,
});

await app.register(jwtPlugin);
await app.register(authenticatePlugin);

await app.register(multipart, {
  limits: {
    fileSize: 20 * 1024 * 1024,
    files: 1,
  },
});
await app.register(authRoutes, {
  prefix: "/auth",
});

await app.register(documentRoutes, {
  prefix: "/documents",
});

const embedQuery = createEmbedQueryUseCase();

const vectorSearch = createVectorSearchUseCase();

const contextBuilder = createContextBuilderUseCase();

const embedding = await embedQuery.execute("backend development");

const results = await vectorSearch.execute({
  queryEmbedding: embedding,
  userId: "cmsg5bo980000uiqg7m2p5o2y",
});
const builtContext = contextBuilder.execute(results);

console.log("Sources:");
console.log(builtContext.sources);

console.log("Context:");
console.log(builtContext.context);

app.get("/test-queue", async (_request, reply) => {
  const queueService = new DocumentQueueService();

  await queueService.enqueue("test-123");

  return reply.send({
    success: true,
    message: "Job queued",
  });
});

app.get(
  "/me",
  {
    preHandler: [app.authenticate],
  },
  async (request) => {
    return request.user;
  },
);

app.get("/health", async () => {
  return {
    status: "ok",
  };
});

export default app;

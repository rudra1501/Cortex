import Fastify from "fastify";
import jwtPlugin from "./plugins/jwt.js";
import authRoutes from "./modules/auth/presentation/auth.routes.js";
import authenticatePlugin from "./plugins/authenticate.js";
import documentRoutes from "./modules/documents/presentation/document.routes.js";
import { DocumentQueueService } from "./modules/documents/infrastructure/document-queue.service.js";
import multipart from "@fastify/multipart";
import chatRoutes from "./modules/chat/presentation/chat.routes.js";

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

await app.register(chatRoutes, {
  prefix: "/chat",
});

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

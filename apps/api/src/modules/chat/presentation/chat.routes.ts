import type { FastifyInstance } from "fastify";

import { chatController } from "./chat.controller.js";

export default async function chatRoutes(
  app: FastifyInstance,
) {
  app.post(
    "/",
    {
      preHandler: [app.authenticate],
    },
    chatController.ask,
  );
}
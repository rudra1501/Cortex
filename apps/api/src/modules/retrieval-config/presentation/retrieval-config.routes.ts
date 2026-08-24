import type { FastifyInstance } from "fastify";

import {
  retrievalConfigController,
} from "./retrieval-config.controller.js";

export default async function retrievalConfigRoutes(
  app: FastifyInstance,
) {
  app.post(
    "/",
    {
      preHandler: [app.authenticate],
    },
    retrievalConfigController.create,
  );

  app.get(
    "/",
    {
      preHandler: [app.authenticate],
    },
    retrievalConfigController.get,
  );

  app.put(
    "/:id",
    {
      preHandler: [app.authenticate],
    },
    retrievalConfigController.update,
  );
}
import type { FastifyPluginAsync } from "fastify";

import { documentController } from "./document.controller.js";

const documentRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/",
    {
      preHandler: [app.authenticate],
    },
    documentController.create,
  );

  app.get(
    "/",
    {
      preHandler: [app.authenticate],
    },
    documentController.list,
  );

  app.get(
    "/:id",
    {
      preHandler: [app.authenticate],
    },
    documentController.get,
  );

  app.patch(
    "/:id",
    {
      preHandler: [app.authenticate],
    },
    documentController.update,
  );

  app.delete(
    "/:id",
    {
      preHandler: [app.authenticate],
    },
    documentController.delete,
  );
};

export default documentRoutes;

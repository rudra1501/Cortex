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
};

export default documentRoutes;
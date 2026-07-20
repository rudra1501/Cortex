import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

const authenticatePlugin: FastifyPluginAsync = async (app) => {
  app.decorate(
    "authenticate",
    async function (request, reply) {
      try {
        await request.jwtVerify();
      } catch {
        return reply.status(401).send({
          message: "Unauthorized",
        });
      }
    },
  );
};

export default fp(authenticatePlugin);
import Fastify from "fastify";
import jwtPlugin from "./plugins/jwt.js";
import authRoutes from "./modules/auth/presentation/auth.routes.js";
import authenticatePlugin from "./plugins/authenticate.js";
import documentRoutes from "./modules/documents/presentation/document.routes.js";

const app = Fastify({
  logger: true,
});

await app.register(jwtPlugin);
await app.register(authenticatePlugin);

await app.register(authRoutes, {
  prefix: "/auth",
})

await app.register(documentRoutes, {
  prefix: "/documents",
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
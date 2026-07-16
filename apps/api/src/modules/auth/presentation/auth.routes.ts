import type { FastifyPluginAsync } from "fastify";
import { authController } from "./auth.controller.js";

const authRoutes: FastifyPluginAsync = async (app) => {
  app.post("/register", authController.register);
  app.post("/login", authController.login);
  app.post("/refresh", authController.refresh);
};

export default authRoutes;
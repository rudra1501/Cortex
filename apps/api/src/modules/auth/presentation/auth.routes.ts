import type { FastifyPluginAsync } from "fastify";
import { authController } from "./auth.controller.js";

const authRoutes: FastifyPluginAsync = async (app) => {
  app.post("/register", authController.register);
};

export default authRoutes;
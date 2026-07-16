import type { FastifyRequest, FastifyReply } from "fastify";
import { loginSchema, refreshSchema, registerSchema } from "./auth.schema.js";
import {
  createLoginUser,
  createRefreshToken,
  createRegisterUser,
} from "../infrastructure/auth.factory.js";

export const authController = {
  async register(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = registerSchema.parse(request.body);

      const registerUser = createRegisterUser(request.server);

      const result = await registerUser.execute(body);

      return reply.code(201).send(result);
    } catch (error) {
      if (error instanceof Error) {
        return reply.status(400).send({
          message: error.message,
        });
      }
    }
    return reply.status(500).send({
      message: "Internal server error",
    });
  },

  async login(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = loginSchema.parse(request.body);

      const loginUser = createLoginUser(request.server);

      const result = await loginUser.execute(body);
      return reply.send(result);
    } catch (error) {
      if (error instanceof Error) {
        return reply.status(400).send({
          message: error.message,
        });
      }
    }
    return reply.status(500).send({
      message: "Internal server error",
    });
  },

  async refresh(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = refreshSchema.parse(request.body);

      const refreshToken = createRefreshToken(request.server);

      const result = await refreshToken.execute(body);

      return reply.send(result);
    } catch (error) {
      if (error instanceof Error) {
        return reply.status(401).send({
          message: error.message,
        });
      }

      return reply.status(500).send({
        message: "Internal Server Error",
      });
    }
  },
};

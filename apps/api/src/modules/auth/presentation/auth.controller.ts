import type { FastifyRequest, FastifyReply } from "fastify";
import { loginSchema, registerSchema } from "./auth.schema.js";
import { createLoginUser, createRegisterUser } from "./auth.factory.js";

export const authController = {
  async register(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = registerSchema.parse(request.body);

      const registerUser = createRegisterUser(request.server);

      const result = await registerUser.execute(body);

      return reply.code(201).send(result);
    } catch (error) {
      if(error instanceof Error){
        return reply.status(400).send({
          message: error.message,
        });
      }
    }
    return reply.status(500).send({
      message: "Internal server error",
    })
  },

  async login(request: FastifyRequest, reply: FastifyReply){
    try {
      const body = loginSchema.parse(request.body);

      const loginUser = createLoginUser(request.server);

      const result = await loginUser.execute(body);
      return reply.send(result);

    } catch (error) {
      if(error instanceof Error){
        return reply.status(400).send({
          message: error.message,
        });
      }
    }
    return reply.status(500).send({
      message: "Internal server error",
    })
  }
};

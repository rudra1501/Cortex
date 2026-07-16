import type { FastifyRequest, FastifyReply } from "fastify";
import { registerSchema } from "./auth.schema.js";
import { RegisterUser } from "../application/register-user.js";
import { PrismaUserRepository } from "../infrastructure/prisma-user-repository.js";
import { PasswordService } from "../infrastructure/password.service.js";
import { JwtService } from "../infrastructure/jwt.service.js";

export const authController = {
  async register(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = registerSchema.parse(request.body);

      const registerUser = new RegisterUser(
        new PrismaUserRepository(),
        new PasswordService(),
        new JwtService(request.server),
      );

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
};

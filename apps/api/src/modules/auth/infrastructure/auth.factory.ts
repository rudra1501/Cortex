import type { FastifyInstance } from "fastify";

import { PasswordService } from "../infrastructure/password.service.js";
import { PrismaUserRepository } from "../infrastructure/prisma-user-repository.js";
import { JwtService } from "../infrastructure/jwt.service.js";
import { RegisterUser } from "../application/register-user.js";
import { LoginUser } from "../application/login-user.js";
import { RefreshToken } from "../application/refresh-token.js";

export function createRegisterUser(app: FastifyInstance) {
  const userRepository = new PrismaUserRepository();
  const passwordService = new PasswordService();
  const jwtService = new JwtService(app);

  return new RegisterUser(
    userRepository,
    passwordService,
    jwtService,
  );
}

export function createLoginUser(app: FastifyInstance) {
  const userRepository = new PrismaUserRepository();
  const passwordService = new PasswordService();
  const jwtService = new JwtService(app);

  return new LoginUser(
    userRepository,
    passwordService,
    jwtService,
  );
}

export function createRefreshToken(app: FastifyInstance) {
  return new RefreshToken(
    new JwtService(app),
  );
}
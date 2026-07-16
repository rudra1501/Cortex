import type { FastifyInstance } from "fastify";

export class JwtService {
  constructor(private readonly app: FastifyInstance) {}

  async generateAccessToken(payload: { userId: string; email: string }) {
    return this.app.jwt.sign(payload);
  }
}
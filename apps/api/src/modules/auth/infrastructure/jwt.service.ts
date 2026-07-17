import type { FastifyInstance } from "fastify";

type JwtPayload = { userId: string; email: string }

export class JwtService {
  constructor(private readonly app: FastifyInstance) {}

  generateAccessToken(payload: JwtPayload) {
    return this.app.jwt.sign(payload,{
        expiresIn: "15m",
    });
  }

    generateRefreshToken(payload: JwtPayload) {
    return this.app.jwt.sign(payload,{
        expiresIn: "7d",
    });
  }

   async verifyRefreshToken(token: string) {
    return this.app.jwt.verify<JwtPayload>(token);
  }
}
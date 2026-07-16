import { JwtService } from "../infrastructure/jwt.service.js";

type RefreshTokenInput = {
  refreshToken: string;
};

export class RefreshToken {
  constructor(private readonly jwtService: JwtService) {}

  async execute({ refreshToken }: RefreshTokenInput) {
    const payload = await this.jwtService.verifyRefreshToken(refreshToken);

    const accessToken = this.jwtService.generateAccessToken({
      userId: payload.userId,
      email: payload.email,
    });

    return {
      accessToken,
    };
  }
}

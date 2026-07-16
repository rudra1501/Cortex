import { PasswordService } from "../infrastructure/password.service.js";
import { PrismaUserRepository } from "../infrastructure/prisma-user-repository.js";
import { JwtService } from "../infrastructure/jwt.service.js";

type LoginUserInput = {
  email: string;
  password: string;
};

export class LoginUser {
  constructor(
    private readonly userRepository: PrismaUserRepository,
    private readonly passwordService: PasswordService,
    private readonly jwtService: JwtService,
  ) {}

  async execute({ email, password }: LoginUserInput) {
    const user = await this.userRepository.findByEmail(email);

    if (!user) {
      throw new Error("Invalid email or password");
    }

    const passwordMatches = await this.passwordService.compare(
      password,
      user.password,
    );

    if (!passwordMatches) {
      throw new Error("Invalid email or password");
    }

    const payload = {
      userId: user.id,
      email: user.email,
    };

    const accessToken = await this.jwtService.generateAccessToken(payload);

    const refreshToken = await this.jwtService.generateRefreshToken(payload);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
      },
    };
  }
}

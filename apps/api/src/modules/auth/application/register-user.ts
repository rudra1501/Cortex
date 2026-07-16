import { PasswordService } from "../infrastructure/password.service.js";
import { PrismaUserRepository } from "../infrastructure/prisma-user-repository.js";
import { JwtService } from "../infrastructure/jwt.service.js";

type RegisterUserInput = {
  email: string;
  password: string;
};

export class RegisterUser {
  constructor(
    private readonly userRepository: PrismaUserRepository,
    private readonly passwordService: PasswordService,
    private readonly jwtService: JwtService,
  ) {}

  async execute({ email, password }: RegisterUserInput) {
    const existingUser = await this.userRepository.findByEmail(email);

    if (existingUser) {
      throw new Error("User already exists");
    }

    const passwordHash = await this.passwordService.hash(password);

    const user = await this.userRepository.create(email, passwordHash);

    const accessToken = await this.jwtService.generateAccessToken({
      userId: user.id,
      email: user.email,
    });

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
      },
    };
  }
}
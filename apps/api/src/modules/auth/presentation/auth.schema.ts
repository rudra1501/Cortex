import z from "zod";

export const registerSchema = z.object({
    email: z.email(),
    password: z.string().min(8),
})

export const loginSchema = z.object({
    email: z.email(),
    password: z.string().min(8),
})

export const refreshSchema = z.object({
  refreshToken: z.string(),
});

export type RegisterSchema = z.infer<typeof registerSchema>;
export type LoginSchema = z.infer<typeof loginSchema>;
export type RefreshSchema = z.infer<typeof refreshSchema>;
import { z } from 'zod'

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  BASE_URL: z.string().url(),
  CREATE_KEY: z.string().min(1),
  SLEEPER_SYNC: z.enum(['0', '1']).default('0'),
})
export type Env = z.infer<typeof EnvSchema>

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return EnvSchema.parse(source)
}

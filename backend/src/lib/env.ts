import { config } from 'dotenv'
config()

function requireEnv(name: string): string {
  const val = process.env[name]
  if (!val) throw new Error(`Environment variable "${name}" is required but not set`)
  return val
}

export const env = {
  PORT: Number(process.env.PORT) || 3000,
  SESSION_SECRET:
    process.env.SESSION_SECRET ?? 'ciclo-estudos-dev-secret-at-least-32-chars',
  GEMINI_API_KEY: requireEnv('GEMINI_API_KEY'),
  GOOGLE_CLIENT_ID: requireEnv('GOOGLE_CLIENT_ID'),
  GOOGLE_CLIENT_SECRET: requireEnv('GOOGLE_CLIENT_SECRET'),
  GOOGLE_REDIRECT_URI: requireEnv('GOOGLE_REDIRECT_URI'),
  FRONTEND_URL: requireEnv('FRONTEND_URL'),
}

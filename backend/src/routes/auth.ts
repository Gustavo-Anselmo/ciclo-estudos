import type { FastifyInstance } from 'fastify'
import { mkdir, writeFile } from 'fs/promises'
import path from 'path'
import { getAuthUrl, getTokensFromCode } from '../lib/googleAuth.js'
import { env } from '../lib/env.js'

const DATA_DIR = path.join(process.cwd(), 'data')
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json')

export async function authRoutes(app: FastifyInstance) {
  app.get('/auth/google', async (_request, reply) => {
    return reply.redirect(getAuthUrl())
  })

  app.get<{ Querystring: { code?: string; error?: string } }>(
    '/auth/google/callback',
    async (request, reply) => {
      const { code, error } = request.query

      if (error || !code) {
        app.log.warn({ error }, 'Google OAuth negado ou sem código')
        return reply.redirect(`${env.FRONTEND_URL}?auth=error`)
      }

      try {
        const tokens = await getTokensFromCode(code)
        await mkdir(DATA_DIR, { recursive: true })
        await writeFile(TOKENS_FILE, JSON.stringify(tokens, null, 2))
        app.log.info('Tokens do Google Calendar salvos com sucesso')
        return reply.redirect(`${env.FRONTEND_URL}?auth=success`)
      } catch (err) {
        app.log.error(err, 'Falha ao trocar code por tokens')
        return reply.redirect(`${env.FRONTEND_URL}?auth=error`)
      }
    },
  )
}

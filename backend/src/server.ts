import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyCookie from '@fastify/cookie'
import fastifySession from '@fastify/session'
import { env } from './lib/env.js'
import { recommendationRoutes } from './routes/recommendation.js'
import { authRoutes } from './routes/auth.js'
import { calendarRoutes } from './routes/calendar.js'
import { examRoutes } from './routes/exam.js'
import { notificationRoutes } from './routes/notifications.js'
import { progressRoutes } from './routes/progress.js'
import { scheduleNotifications } from './jobs/notifications.js'

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error)
})
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason)
})

const app = Fastify({ logger: true })

await app.register(cors, {
  origin: [
    'https://gustavo-anselmo.github.io',
    'http://localhost:5500',
    'http://localhost:3000',
  ],
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
})

await app.register(fastifyCookie)

await app.register(fastifySession, {
  secret: env.SESSION_SECRET,
  cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true },
  saveUninitialized: false,
})

app.get('/health', async () => {
  return { status: 'ok' }
})

await app.register(recommendationRoutes)
await app.register(authRoutes)
await app.register(calendarRoutes)
await app.register(examRoutes)
await app.register(notificationRoutes)
await app.register(progressRoutes)

const port = env.PORT

app.listen({ port, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err)
    process.exit(1)
  }
  scheduleNotifications()
})

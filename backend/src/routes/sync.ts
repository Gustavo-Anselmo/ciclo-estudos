import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'

// ── types ──────────────────────────────────────────────────────────────────────

interface TopicInput {
  id: string
  text: string
  completed: boolean
}

interface SubjectInput {
  id: string
  name: string
  dailyGoal: number
  order: number
  topics: TopicInput[]
}

interface SessionInput {
  id: string
  subject: string
  start: string
  end: string
  duration: number
  pauseDuration: number
}

interface StateInput {
  subjects: SubjectInput[]
  sessions: SessionInput[]
  constantSubjects: string[]
  currentIndex: number
}

// ── helpers ───────────────────────────────────────────────────────────────────

function emptyState() {
  return { subjects: [], sessions: [], constantSubjects: [], currentIndex: 0 }
}

async function loadUserState(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      subjects: {
        orderBy: { order: 'asc' },
        include: { topics: { orderBy: { createdAt: 'asc' } } },
      },
      sessions: { orderBy: { start: 'asc' } },
    },
  })

  if (!user) return null

  return {
    subjects: user.subjects.map((s) => ({
      id: s.id,
      name: s.name,
      dailyGoal: s.dailyGoal,
      order: s.order,
      topics: s.topics.map((t) => ({ id: t.id, text: t.text, completed: t.completed })),
    })),
    sessions: user.sessions.map((s) => ({
      id: s.id,
      subject: s.subject,
      start: s.start.toISOString(),
      end: s.end.toISOString(),
      duration: s.duration,
      pauseDuration: s.pauseDuration,
    })),
    constantSubjects: user.constantSubjects,
    currentIndex: user.currentIndex,
  }
}

// ── routes ────────────────────────────────────────────────────────────────────

export async function syncRoutes(app: FastifyInstance) {
  // POST /api/sync/init
  app.post<{ Body: { userId?: string } }>('/api/sync/init', async (request, reply) => {
    const { userId } = request.body ?? {}

    if (userId) {
      const state = await loadUserState(userId)
      if (state) return reply.code(200).send({ userId, state })
    }

    const user = await prisma.user.create({ data: {} })
    return reply.code(201).send({ userId: user.id, state: emptyState() })
  })

  // PUT /api/sync/state
  app.put<{ Body: { userId: string; state: StateInput } }>('/api/sync/state', async (request, reply) => {
    const { userId, state } = request.body

    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) return reply.code(404).send({ error: 'USER_NOT_FOUND' })

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { currentIndex: state.currentIndex, constantSubjects: state.constantSubjects },
      })

      const validSubjectIds = (state.subjects as any[])
        .map((s) => s.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)

      await tx.subject.deleteMany({
        where: { userId, ...(validSubjectIds.length > 0 ? { id: { notIn: validSubjectIds } } : {}) },
      })

      for (const s of state.subjects as any[]) {
        const subjectId = s.id && typeof s.id === 'string' ? s.id : crypto.randomUUID()

        await tx.subject.upsert({
          where: { id: subjectId },
          create: { id: subjectId, name: s.name, dailyGoal: s.dailyGoal, order: s.order, userId },
          update: { name: s.name, dailyGoal: s.dailyGoal, order: s.order },
        })

        const validTopicIds = (s.topics as any[])
          .map((t: any) => t.id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)

        await tx.topic.deleteMany({
          where: {
            subjectId,
            ...(validTopicIds.length > 0 ? { id: { notIn: validTopicIds } } : {}),
          },
        })

        for (const t of s.topics as any[]) {
          const topicId = t.id && typeof t.id === 'string' ? t.id : crypto.randomUUID()

          await tx.topic.upsert({
            where: { id: topicId },
            create: { id: topicId, text: t.text, completed: t.completed, subjectId },
            update: { text: t.text, completed: t.completed },
          })
        }
      }

      if (state.sessions.length > 0) {
        const existing = await tx.session.findMany({
          where: { id: { in: state.sessions.map((s) => s.id) } },
          select: { id: true },
        })
        const existingIds = new Set(existing.map((s) => s.id))
        const newSessions = state.sessions.filter((s) => !existingIds.has(s.id))

        if (newSessions.length > 0) {
          await tx.session.createMany({
            data: newSessions.map((s) => ({
              id: s.id,
              subject: s.subject,
              start: new Date(s.start),
              end: new Date(s.end),
              duration: s.duration,
              pauseDuration: s.pauseDuration,
              userId,
            })),
          })
        }
      }
    })

    return reply.code(200).send({ success: true })
  })

  // POST /api/sync/session
  app.post<{ Body: { userId: string; session: SessionInput } }>('/api/sync/session', async (request, reply) => {
    const { userId, session } = request.body

    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) return reply.code(404).send({ error: 'USER_NOT_FOUND' })

    const created = await prisma.session.upsert({
      where: { id: session.id },
      create: {
        id: session.id,
        subject: session.subject,
        start: new Date(session.start),
        end: new Date(session.end),
        duration: session.duration,
        pauseDuration: session.pauseDuration,
        userId,
      },
      update: {},
    })

    return reply.code(201).send({
      success: true,
      session: {
        id: created.id,
        subject: created.subject,
        start: created.start.toISOString(),
        end: created.end.toISOString(),
        duration: created.duration,
        pauseDuration: created.pauseDuration,
      },
    })
  })

  // DELETE /api/sync/sessions
  app.delete<{ Body: { userId: string } }>('/api/sync/sessions', async (request, reply) => {
    const { userId } = request.body

    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) return reply.code(404).send({ error: 'USER_NOT_FOUND' })

    await prisma.session.deleteMany({ where: { userId } })

    return reply.code(200).send({ success: true })
  })
}

import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'

export async function taskRoutes(app: FastifyInstance) {
  // GET /api/tasks
  app.get<{ Querystring: { userId: string } }>('/api/tasks', async (request, reply) => {
    const { userId } = request.query
    if (!userId) return reply.code(400).send({ error: 'userId required' })

    const tasks = await prisma.task.findMany({
      where: { userId },
      orderBy: { order: 'asc' },
      include: { topics: { orderBy: { order: 'asc' } } },
    })

    return reply.code(200).send(tasks)
  })

  // POST /api/tasks
  app.post<{ Body: { userId: string; title: string; subjectName: string; topics: string[] } }>(
    '/api/tasks',
    async (request, reply) => {
      const { userId, title, subjectName, topics = [] } = request.body

      if (!userId || !title || !subjectName) {
        return reply.code(400).send({ error: 'userId, title and subjectName required' })
      }

      const user = await prisma.user.findUnique({ where: { id: userId } })
      if (!user) return reply.code(404).send({ error: 'USER_NOT_FOUND' })

      const lastTask = await prisma.task.findFirst({
        where: { userId },
        orderBy: { order: 'desc' },
        select: { order: true },
      })
      const nextOrder = (lastTask?.order ?? -1) + 1

      const task = await prisma.task.create({
        data: {
          title,
          subjectName,
          userId,
          order: nextOrder,
          topics: {
            create: topics.map((text, i) => ({ text, state: 'pending', order: i })),
          },
        },
        include: { topics: { orderBy: { order: 'asc' } } },
      })

      return reply.code(201).send(task)
    },
  )

  // PATCH /api/tasks/:id
  app.patch<{
    Params: { id: string }
    Body: { totalTime?: number; status?: string; order?: number }
  }>('/api/tasks/:id', async (request, reply) => {
    const { id } = request.params
    const { totalTime, status, order } = request.body

    const data: Record<string, unknown> = {}
    if (totalTime !== undefined) data.totalTime = totalTime
    if (status !== undefined) data.status = status
    if (order !== undefined) data.order = order

    const task = await prisma.task.update({
      where: { id },
      data,
      include: { topics: { orderBy: { order: 'asc' } } },
    })

    return reply.code(200).send(task)
  })

  // PATCH /api/tasks/:id/topics/:topicId
  app.patch<{
    Params: { id: string; topicId: string }
    Body: { state: string }
  }>('/api/tasks/:id/topics/:topicId', async (request, reply) => {
    const { topicId } = request.params
    const { state } = request.body

    const topic = await prisma.taskTopic.update({
      where: { id: topicId },
      data: { state },
    })

    return reply.code(200).send(topic)
  })

  // DELETE /api/tasks/:id
  app.delete<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    const { id } = request.params

    await prisma.task.delete({ where: { id } })

    return reply.code(200).send({ success: true })
  })
}

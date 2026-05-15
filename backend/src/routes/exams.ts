import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'

function addDays(date: Date, n: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

export async function examCrudRoutes(app: FastifyInstance) {
  // GET /api/exams
  app.get<{ Querystring: { userId: string } }>('/api/exams', async (request, reply) => {
    const { userId } = request.query
    if (!userId) return reply.code(400).send({ error: 'userId required' })

    const exams = await prisma.exam.findMany({
      where: { userId },
      orderBy: { examDate: 'asc' },
      include: { checkpoints: { orderBy: { scheduledDate: 'asc' } } },
    })

    return reply.code(200).send(exams)
  })

  // POST /api/exams
  app.post<{ Body: { userId: string; subjectName: string; examDate: string; notes?: string } }>(
    '/api/exams',
    async (request, reply) => {
      const { userId, subjectName, examDate, notes } = request.body

      if (!userId || !subjectName || !examDate) {
        return reply.code(400).send({ error: 'userId, subjectName and examDate required' })
      }

      const user = await prisma.user.findUnique({ where: { id: userId } })
      if (!user) return reply.code(404).send({ error: 'USER_NOT_FOUND' })

      const examDateObj = new Date(examDate)
      const now = new Date()

      const offsets = [5, 3, 1]
      const checkpointData = offsets
        .map((days) => ({ daysBeforeExam: days, scheduledDate: addDays(examDateObj, -days) }))
        .filter(({ scheduledDate }) => scheduledDate > now)

      const exam = await prisma.exam.create({
        data: {
          subjectName,
          examDate: examDateObj,
          notes: notes ?? null,
          userId,
          checkpoints: {
            create: checkpointData.map(({ daysBeforeExam, scheduledDate }) => ({
              daysBeforeExam,
              scheduledDate,
            })),
          },
        },
        include: { checkpoints: { orderBy: { scheduledDate: 'asc' } } },
      })

      return reply.code(201).send(exam)
    },
  )

  // PATCH /api/exams/:id/checkpoints/:checkpointId
  app.patch<{
    Params: { id: string; checkpointId: string }
    Body: { hitRate: number }
  }>('/api/exams/:id/checkpoints/:checkpointId', async (request, reply) => {
    const { checkpointId } = request.params
    const { hitRate } = request.body

    const checkpoint = await prisma.examCheckpoint.update({
      where: { id: checkpointId },
      data: { hitRate, completed: true },
    })

    return reply.code(200).send(checkpoint)
  })

  // DELETE /api/exams/:id
  app.delete<{ Params: { id: string } }>('/api/exams/:id', async (request, reply) => {
    const { id } = request.params

    await prisma.exam.delete({ where: { id } })

    return reply.code(200).send({ success: true })
  })
}

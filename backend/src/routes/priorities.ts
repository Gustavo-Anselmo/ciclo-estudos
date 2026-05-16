import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { askGroq, parseAIJSON } from '../lib/groqClient.js'

interface SubjectInput {
  name: string
  weeklyGoalMinutes?: number
}

interface PriorityItem {
  subjectName: string
  urgencyLevel: 'critical' | 'high' | 'medium' | 'low'
  reason: string
  pendingTopics: number
}

interface PrioritiesResponse {
  priorities: PriorityItem[]
  summary: string
}

function buildPrioritiesPrompt(
  subjects: SubjectInput[],
  pendingTasks: { subjectName: string; topicCount: number }[],
  upcomingExams: { subjectName: string; examDate: string; daysUntil: number; avgHitRate: number | null }[],
  sessionsBySubject: { subject: string; totalMinutes: number }[],
): string {
  const subjectsText = subjects.length
    ? subjects.map((s) => `- ${s.name}${s.weeklyGoalMinutes ? ` (meta: ${s.weeklyGoalMinutes}min/semana)` : ''}`).join('\n')
    : 'Nenhuma matéria cadastrada.'

  const tasksText = pendingTasks.length
    ? pendingTasks.map((t) => `- ${t.subjectName}: ${t.topicCount} tópicos pendentes`).join('\n')
    : 'Sem tarefas pendentes.'

  const examsText = upcomingExams.length
    ? upcomingExams
        .map((e) => {
          const hitInfo = e.avgHitRate !== null ? `, taxa de acertos: ${e.avgHitRate.toFixed(0)}%` : ''
          return `- ${e.subjectName}: prova em ${e.daysUntil} dia(s) (${e.examDate}${hitInfo})`
        })
        .join('\n')
    : 'Nenhuma prova próxima.'

  const sessionsText = sessionsBySubject.length
    ? sessionsBySubject.map((s) => `- ${s.subject}: ${s.totalMinutes} minutos nos últimos 14 dias`).join('\n')
    : 'Nenhuma sessão nos últimos 14 dias.'

  return `Você é um assistente de estudos. Analise os dados abaixo e gere uma lista de prioridades de estudo.

=== MATÉRIAS DO CICLO ===
${subjectsText}

=== TAREFAS PENDENTES ===
${tasksText}

=== PROVAS PRÓXIMAS ===
${examsText}

=== HISTÓRICO DE ESTUDO (últimos 14 dias) ===
${sessionsText}

=== CRITÉRIOS DE URGÊNCIA ===
- critical: prova em ≤3 dias OU taxa de acertos <50% com prova próxima
- high: prova em ≤7 dias OU muitos tópicos pendentes sem estudo recente
- medium: prova em ≤14 dias OU tópicos pendentes com algum estudo recente
- low: sem prazo próximo, apenas manutenção

Responda APENAS com JSON válido, sem markdown, sem texto adicional:
{
  "priorities": [
    {
      "subjectName": "nome da matéria",
      "urgencyLevel": "critical" | "high" | "medium" | "low",
      "reason": "motivo em uma frase curta",
      "pendingTopics": número inteiro
    }
  ],
  "summary": "resumo geral em uma frase"
}`
}

export async function priorityRoutes(app: FastifyInstance) {
  app.post<{ Body: { userId: string; subjects: SubjectInput[] } }>(
    '/api/priorities',
    async (request, reply) => {
      const { userId, subjects = [] } = request.body

      if (!userId) return reply.code(400).send({ error: 'userId required' })

      const user = await prisma.user.findUnique({ where: { id: userId } })
      if (!user) return reply.code(404).send({ error: 'USER_NOT_FOUND' })

      // Pending tasks grouped by subject
      const tasks = await prisma.task.findMany({
        where: { userId, status: 'pending' },
        include: { topics: { where: { state: 'pending' } } },
      })
      const pendingTasks = tasks.map((t) => ({
        subjectName: t.subjectName,
        topicCount: t.topics.length,
      }))

      // Upcoming exams (next 30 days)
      const now = new Date()
      const in30Days = new Date(now)
      in30Days.setDate(in30Days.getDate() + 30)

      const exams = await prisma.exam.findMany({
        where: { userId, examDate: { gte: now, lte: in30Days } },
        orderBy: { examDate: 'asc' },
        include: { checkpoints: { where: { completed: true } } },
      })
      const upcomingExams = exams.map((e) => {
        const daysUntil = Math.ceil((e.examDate.getTime() - now.getTime()) / 86400000)
        const completedCheckpoints = e.checkpoints.filter((c) => c.hitRate !== null)
        const avgHitRate =
          completedCheckpoints.length > 0
            ? completedCheckpoints.reduce((acc, c) => acc + (c.hitRate ?? 0), 0) / completedCheckpoints.length
            : null
        return {
          subjectName: e.subjectName,
          examDate: e.examDate.toLocaleDateString('pt-BR'),
          daysUntil,
          avgHitRate,
        }
      })

      // Sessions last 14 days grouped by subject
      const since14Days = new Date(now)
      since14Days.setDate(since14Days.getDate() - 14)

      const sessions = await prisma.session.findMany({
        where: { userId, end: { gte: since14Days } },
        select: { subject: true, duration: true },
      })
      const sessionMap: Record<string, number> = {}
      for (const s of sessions) {
        sessionMap[s.subject] = (sessionMap[s.subject] ?? 0) + s.duration
      }
      const sessionsBySubject = Object.entries(sessionMap)
        .map(([subject, totalSecs]) => ({ subject, totalMinutes: Math.round(totalSecs / 60) }))
        .sort((a, b) => b.totalMinutes - a.totalMinutes)

      const prompt = buildPrioritiesPrompt(subjects, pendingTasks, upcomingExams, sessionsBySubject)

      const buildFallback = () => {
        const fallbackPriorities = subjects.map(s => {
          const mins = sessionsBySubject.find(ss => ss.subject === s.name)?.totalMinutes ?? 0
          const exam = upcomingExams.find(e => e.subjectName === s.name)
          const urgencyLevel: PriorityItem['urgencyLevel'] = exam && exam.daysUntil <= 7 ? 'critical'
            : exam && exam.daysUntil <= 14 ? 'high'
            : mins === 0 ? 'high'
            : mins < 60 ? 'medium' : 'low'
          return {
            subjectName: s.name,
            urgencyLevel,
            reason: exam
              ? `Prova em ${exam.daysUntil} dia(s)`
              : mins === 0 ? 'Sem estudo nos últimos 14 dias' : `${mins}min estudados`,
            pendingTopics: pendingTasks.find(t => t.subjectName === s.name)?.topicCount ?? 0,
          }
        }).sort((a, b) => {
          const order = { critical: 0, high: 1, medium: 2, low: 3 }
          return order[a.urgencyLevel] - order[b.urgencyLevel]
        })
        return {
          priorities: fallbackPriorities,
          summary: 'Prioridades calculadas automaticamente — IA temporariamente indisponível.',
          isFallback: true,
        }
      }

      let raw: string
      try {
        raw = await askGroq(prompt)
      } catch (err) {
        app.log.warn({ err }, 'Groq falhou — usando fallback em priorities')
        return reply.code(200).send(buildFallback())
      }

      let result: PrioritiesResponse
      try {
        result = parseAIJSON<PrioritiesResponse>(raw)
      } catch {
        app.log.warn('Groq parse falhou — usando fallback em priorities')
        return reply.code(200).send(buildFallback())
      }

      return reply.code(200).send(result)
    },
  )
}

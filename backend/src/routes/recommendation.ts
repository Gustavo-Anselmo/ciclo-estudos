import type { FastifyInstance } from 'fastify'
import { askGroq, parseAIJSON } from '../lib/groqClient.js'

interface SessionToday {
  subject: string
  duration: number
  start: string
  end: string
}

interface Subject {
  name: string
  weeklyGoalMinutes: number
}

interface RecommendationBody {
  currentHour: number
  sessionsToday: SessionToday[]
  subjects: Subject[]
  context?: string
}

export const USER_CONTEXT =
  'O usuário é estudante universitário com três frentes de estudo: faculdade (prioridade alta), ' +
  'concurso público (prioridade alta) e inglês (prioridade média). Prefere conteúdo difícil de manhã, ' +
  'revisão à tarde, e inglês ou descanso à noite. Precisa de pausas entre blocos longos.'

function buildPrompt(body: RecommendationBody): string {
  const { currentHour, sessionsToday, subjects, context } = body

  const sessionsSummary =
    sessionsToday.length === 0
      ? 'Nenhuma sessão registrada hoje.'
      : sessionsToday
          .map(
            (s) =>
              `- ${s.subject}: ${Math.round(s.duration / 60)} min (${s.start} → ${s.end})`,
          )
          .join('\n')

  const subjectsList =
    subjects.length === 0
      ? 'Nenhuma matéria cadastrada.'
      : subjects.map((s) => `- ${s.name}: meta semanal de ${s.weeklyGoalMinutes} min`).join('\n')

  const totalTodayMin = Math.round(sessionsToday.reduce((acc, s) => acc + s.duration, 0) / 60)

  return `Você é um conselheiro de estudos especializado. Com base nos dados abaixo, forneça uma recomendação personalizada de estudo.

Contexto do usuário:
${USER_CONTEXT}
${context ? `\nContexto adicional: ${context}` : ''}

Dados atuais:
- Horário atual: ${currentHour}:00
- Total estudado hoje: ${totalTodayMin} minutos
- Sessões de hoje:
${sessionsSummary}

Matérias disponíveis (com metas semanais):
${subjectsList}

Responda APENAS com um JSON válido, sem markdown, no seguinte formato:
{
  "recommendation": "Recomendação breve e acionável do que estudar a seguir (1-2 frases)",
  "reasoning": "Explicação do motivo desta recomendação dado o contexto e dados (2-3 frases)"
}`
}

export async function recommendationRoutes(app: FastifyInstance) {
  app.post<{ Body: RecommendationBody }>(
    '/api/recommendation',
    {
      schema: {
        body: {
          type: 'object',
          required: ['currentHour', 'sessionsToday', 'subjects'],
          properties: {
            currentHour: { type: 'number', minimum: 0, maximum: 23 },
            sessionsToday: {
              type: 'array',
              items: {
                type: 'object',
                required: ['subject', 'duration', 'start', 'end'],
                properties: {
                  subject: { type: 'string' },
                  duration: { type: 'number' },
                  start: { type: 'string' },
                  end: { type: 'string' },
                },
              },
            },
            subjects: {
              type: 'array',
              items: {
                type: 'object',
                required: ['name', 'weeklyGoalMinutes'],
                properties: {
                  name: { type: 'string' },
                  weeklyGoalMinutes: { type: 'number' },
                },
              },
            },
            context: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      let rawText: string
      try {
        rawText = await askGroq(buildPrompt(request.body))
      } catch (err: unknown) {
        app.log.error(err, 'Gemini call failed')
        const message = err instanceof Error ? err.message : String(err)
        return reply.status(500).send({ error: 'AI_ERROR', message })
      }

      let parsed: { recommendation: string; reasoning: string }
      try {
        parsed = parseAIJSON<{ recommendation: string; reasoning: string }>(rawText)
      } catch {
        return reply.status(500).send({ error: 'AI_PARSE_ERROR', raw: rawText })
      }

      if (!parsed.recommendation) {
        return reply.status(500).send({ error: 'AI_PARSE_ERROR', raw: rawText })
      }

      return reply.send({
        recommendation: parsed.recommendation,
        reasoning: parsed.reasoning ?? '',
      })
    },
  )
}

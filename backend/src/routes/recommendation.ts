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

interface CalendarEvent {
  title: string
  start: string
  end: string
  isAllDay?: boolean
}

interface RecommendationBody {
  currentHour: number
  sessionsToday: SessionToday[]
  subjects: Subject[]
  context?: string
  calendarEvents?: CalendarEvent[]
}

export const USER_CONTEXT =
  'O usuário é estudante universitário com três frentes de estudo: faculdade (prioridade alta), ' +
  'concurso público (prioridade alta) e inglês (prioridade média). Prefere conteúdo difícil de manhã, ' +
  'revisão à tarde, e inglês ou descanso à noite. Precisa de pausas entre blocos longos.'

function buildPrompt(body: RecommendationBody): string {
  const { currentHour, sessionsToday, subjects, context, calendarEvents } = body

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

  const calendarSection =
    calendarEvents && calendarEvents.length > 0
      ? calendarEvents
          .map((e) => {
            const start = new Date(e.start)
            const end = new Date(e.end)
            const timeStr = e.isAllDay
              ? 'dia inteiro'
              : `${start.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} → ${end.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
            return `- ${e.title} (${timeStr})`
          })
          .join('\n')
      : 'Nenhum evento encontrado ou Calendar não conectado.'

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

=== AGENDA DO CALENDÁRIO (hoje e próximos 2 dias) ===
${calendarSection}

Use os eventos do calendário para contextualizar a recomendação. Se houver uma aula ou prova próxima, priorize o estudo relacionado. Mencione eventos específicos na recomendação quando relevante (ex: 'você tem Arquitetura amanhã — revise hoje').

Responda APENAS com um JSON válido, sem markdown:
{
  "recommendation": "Uma frase direta e específica. Máximo 20 palavras. Exemplo: 'Estude Redes agora — prova em 12 dias e você não estudou hoje.'",
  "reasoning": "Uma frase explicando o motivo. Máximo 15 palavras."
}

Regras para a recommendation:
- Sempre cite uma matéria específica pelo nome
- Se houver prova próxima, mencione os dias restantes
- Se já estudou hoje, reconheça e sugira o próximo passo
- Nunca use palavras genéricas como "continue", "foque", "dedique-se"
- Seja cirúrgico: matéria + ação + motivo em uma frase`
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
            calendarEvents: {
              type: 'array',
              items: {
                type: 'object',
                required: ['title', 'start', 'end'],
                properties: {
                  title: { type: 'string' },
                  start: { type: 'string' },
                  end: { type: 'string' },
                  isAllDay: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      let rawText: string
      try {
        rawText = await askGroq(buildPrompt(request.body))
      } catch (err: unknown) {
        app.log.error(err, 'Groq call failed')
        const message = err instanceof Error ? err.message : String(err)
        return reply.code(500).send({ error: 'AI_ERROR', message })
      }

      let parsed: { recommendation: string; reasoning: string }
      try {
        parsed = parseAIJSON<{ recommendation: string; reasoning: string }>(rawText)
      } catch {
        return reply.code(500).send({ error: 'AI_PARSE_ERROR', raw: rawText })
      }

      if (!parsed?.recommendation) {
        return reply.code(500).send({ error: 'AI_PARSE_ERROR', raw: rawText })
      }

      return reply.code(200).send({
        recommendation: parsed.recommendation,
        reasoning: parsed.reasoning ?? '',
      })
    },
  )
}

import type { FastifyInstance } from 'fastify'
import { generateText, parseGeminiJSON } from '../lib/gemini.js'
import { USER_CONTEXT } from './recommendation.js'

// ── types ─────────────────────────────────────────────────────────────────────

interface SubjectInput {
  name: string
  dailyGoal: number   // minutes/day
}

interface SessionInput {
  subject: string
  duration: number    // seconds
  end: string         // ISO datetime
}

interface ProgressBody {
  subjects: SubjectInput[]
  weekStart: string   // ISO datetime
  sessions: SessionInput[]
}

type SubjectStatus = 'completed' | 'on_track' | 'behind' | 'neglected'
type OverallStatus = 'on_track' | 'behind' | 'ahead'

interface SubjectResult {
  name: string
  studiedMinutes: number
  goalMinutes: number
  status: SubjectStatus
  recommendation: string
}

interface DiagnosisResult {
  overallStatus: OverallStatus
  overallMessage: string
  priorityAction: string
  subjects: SubjectResult[]
}

// ── helpers ───────────────────────────────────────────────────────────────────

function computeStatus(studiedMinutes: number, goalMinutes: number): SubjectStatus {
  if (studiedMinutes === 0) return 'neglected'
  if (goalMinutes === 0 || studiedMinutes >= goalMinutes) return 'completed'
  if (studiedMinutes >= goalMinutes * 0.6) return 'on_track'
  return 'behind'
}

function buildPrompt(
  subjects: (SubjectInput & { studiedMinutes: number; goalMinutes: number; status: SubjectStatus })[],
  totalStudiedMinutes: number,
): string {
  const lines = subjects.map((s) => {
    const goalText = s.goalMinutes > 0 ? `${s.goalMinutes}min de meta semanal` : 'sem meta definida'
    return `- ${s.name}: ${s.studiedMinutes}min estudados / ${goalText} | status: ${s.status}`
  })

  return `Você é um conselheiro de estudos. Analise o progresso semanal e forneça um diagnóstico.

Contexto do usuário:
${USER_CONTEXT}

Progresso desta semana:
${lines.join('\n')}
Total estudado esta semana: ${totalStudiedMinutes}min

Responda APENAS com um JSON válido, sem markdown, no formato:
{
  "overallStatus": "on_track" ou "behind" ou "ahead",
  "overallMessage": "mensagem precisa e motivadora sobre o progresso geral (1-2 frases)",
  "priorityAction": "ação prioritária concreta e específica para esta semana (1 frase)",
  "subjects": [
    { "name": "<nome exato>", "recommendation": "recomendação específica para esta matéria (1 frase)" }
  ]
}`
}

// ── route ─────────────────────────────────────────────────────────────────────

export async function progressRoutes(app: FastifyInstance) {
  app.post<{ Body: ProgressBody }>(
    '/api/progress/diagnosis',
    {
      schema: {
        body: {
          type: 'object',
          required: ['subjects', 'weekStart', 'sessions'],
          properties: {
            subjects: {
              type: 'array',
              items: {
                type: 'object',
                required: ['name', 'dailyGoal'],
                properties: {
                  name: { type: 'string' },
                  dailyGoal: { type: 'number' },
                },
              },
            },
            weekStart: { type: 'string' },
            sessions: {
              type: 'array',
              items: {
                type: 'object',
                required: ['subject', 'duration', 'end'],
                properties: {
                  subject: { type: 'string' },
                  duration: { type: 'number' },
                  end: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { subjects, weekStart, sessions } = request.body
      const weekStartDate = new Date(weekStart)

      // Sum study minutes per subject from local sessions (duration is in seconds)
      const studiedMap = new Map<string, number>()
      for (const s of sessions) {
        if (new Date(s.end) >= weekStartDate) {
          studiedMap.set(s.subject, (studiedMap.get(s.subject) ?? 0) + Math.round(s.duration / 60))
        }
      }

      const subjectsWithData = subjects.map((s) => ({
        ...s,
        studiedMinutes: studiedMap.get(s.name) ?? 0,
        goalMinutes: s.dailyGoal > 0 ? s.dailyGoal * 7 : 0,
        status: computeStatus(
          studiedMap.get(s.name) ?? 0,
          s.dailyGoal > 0 ? s.dailyGoal * 7 : 0,
        ),
      }))

      const totalStudiedMinutes = subjectsWithData.reduce((a, s) => a + s.studiedMinutes, 0)

      // Use Gemini for natural-language analysis
      let geminiData: {
        overallStatus: string
        overallMessage: string
        priorityAction: string
        subjects: { name: string; recommendation: string }[]
      }

      try {
        const raw = await generateText(buildPrompt(subjectsWithData, totalStudiedMinutes))
        geminiData = parseGeminiJSON<typeof geminiData>(raw)
      } catch (err) {
        app.log.error(err, 'Gemini failed for progress diagnosis — using fallback')
        const mostNeglected = subjectsWithData.find((s) => s.studiedMinutes === 0)
        geminiData = {
          overallStatus: totalStudiedMinutes > 0 ? 'on_track' : 'behind',
          overallMessage:
            totalStudiedMinutes > 0
              ? 'Você está progredindo esta semana!'
              : 'Nenhuma sessão registrada esta semana. Que tal começar agora?',
          priorityAction: mostNeglected
            ? `Inclua um bloco de ${mostNeglected.name} hoje.`
            : 'Continue mantendo o ritmo de estudos.',
          subjects: subjectsWithData.map((s) => ({
            name: s.name,
            recommendation:
              s.studiedMinutes === 0
                ? 'Não estudada esta semana — inclua um bloco hoje.'
                : 'Continue progredindo.',
          })),
        }
      }

      const recommendationMap = new Map(
        (geminiData.subjects ?? []).map((s) => [s.name, s.recommendation]),
      )

      const validOverallStatuses: OverallStatus[] = ['on_track', 'behind', 'ahead']
      const overallStatus: OverallStatus = validOverallStatuses.includes(
        geminiData.overallStatus as OverallStatus,
      )
        ? (geminiData.overallStatus as OverallStatus)
        : 'on_track'

      const result: DiagnosisResult = {
        overallStatus,
        overallMessage: geminiData.overallMessage ?? '',
        priorityAction: geminiData.priorityAction ?? '',
        subjects: subjectsWithData.map((s) => ({
          name: s.name,
          studiedMinutes: s.studiedMinutes,
          goalMinutes: s.goalMinutes,
          status: s.status,
          recommendation: recommendationMap.get(s.name) ?? '',
        })),
      }

      return reply.send(result)
    },
  )
}

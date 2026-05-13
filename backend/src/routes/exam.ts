import type { FastifyInstance } from 'fastify'
import { getAuthenticatedCalendar } from '../lib/tokenStore.js'
import { USER_CONTEXT } from './recommendation.js'
import { askGroq } from '../lib/groqClient.js'

// ── tipos ─────────────────────────────────────────────────────────────────────

interface ExamPlanBody {
  subject: string
  examDate: string
  topics: string[]
  estimatedHoursTotal: number
}

interface MappedEvent {
  id: string
  title: string
  start: string
  end: string
  description: string
}

interface FreeSlot {
  start: string
  end: string
}

interface GeminiBlock {
  title: string
  start: string
  end: string
  topic: string
  description: string
}

interface GeminiResponse {
  blocks: GeminiBlock[]
  summary: string
}

// ── free-slots (mesma lógica de calendar.ts) ──────────────────────────────────

function addDays(date: Date, n: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

function calcFreeSlots(
  events: MappedEvent[],
  dateMin: Date,
  dateMax: Date,
  minDurationMs: number,
): FreeSlot[] {
  const slots: FreeSlot[] = []

  let day = new Date(dateMin)
  day.setHours(0, 0, 0, 0)

  const lastDay = new Date(dateMax)
  lastDay.setHours(0, 0, 0, 0)

  while (day <= lastDay) {
    const workStart = new Date(day)
    workStart.setHours(7, 0, 0, 0)
    const workEnd = new Date(day)
    workEnd.setHours(22, 0, 0, 0)

    const rangeStart = new Date(Math.max(workStart.getTime(), dateMin.getTime()))
    const rangeEnd = new Date(Math.min(workEnd.getTime(), dateMax.getTime()))

    if (rangeStart < rangeEnd) {
      const dayEvents = events
        .filter((e) => {
          const s = new Date(e.start).getTime()
          const en = new Date(e.end).getTime()
          return s < rangeEnd.getTime() && en > rangeStart.getTime()
        })
        .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())

      let cursor = rangeStart.getTime()

      for (const ev of dayEvents) {
        const evStart = Math.max(new Date(ev.start).getTime(), rangeStart.getTime())
        const evEnd = Math.min(new Date(ev.end).getTime(), rangeEnd.getTime())
        if (evStart > cursor && evStart - cursor >= minDurationMs) {
          slots.push({ start: new Date(cursor).toISOString(), end: new Date(evStart).toISOString() })
        }
        cursor = Math.max(cursor, evEnd)
      }

      if (cursor < rangeEnd.getTime() && rangeEnd.getTime() - cursor >= minDurationMs) {
        slots.push({ start: new Date(cursor).toISOString(), end: rangeEnd.toISOString() })
      }
    }

    day = addDays(day, 1)
  }

  return slots
}

// ── helpers do prompt ─────────────────────────────────────────────────────────

function formatSlotForPrompt(slot: FreeSlot, idx: number): string {
  const start = new Date(slot.start)
  const end = new Date(slot.end)
  const durationMin = Math.round((end.getTime() - start.getTime()) / 60000)
  const h = Math.floor(durationMin / 60)
  const m = durationMin % 60
  const durStr = h > 0 ? `${h}h${m > 0 ? `${m}min` : ''}` : `${m}min`
  const dateStr = start.toLocaleDateString('pt-BR', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
  })
  const startTime = start.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  const endTime = end.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  return (
    `Slot ${idx + 1}: ${dateStr} ${startTime}–${endTime} (${durStr})` +
    ` | start: "${slot.start}" end: "${slot.end}"`
  )
}

function buildExamPrompt(body: ExamPlanBody, slots: FreeSlot[]): string {
  const examDateFormatted = new Date(body.examDate).toLocaleDateString('pt-BR', {
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })

  const slotsText =
    slots.length === 0
      ? 'Nenhum slot disponível encontrado na agenda.'
      : slots.map(formatSlotForPrompt).join('\n')

  return `Você é um planejador de estudos especializado. Crie um plano de estudo detalhado para a prova descrita abaixo.

Contexto do usuário:
${USER_CONTEXT}

=== DADOS DA PROVA ===
Matéria: ${body.subject}
Data da prova: ${examDateFormatted}
Tópicos a estudar: ${body.topics.join(', ')}
Horas estimadas necessárias: ${body.estimatedHoursTotal}h

=== SLOTS DISPONÍVEIS NA AGENDA ===
${slotsText}

=== REGRAS ===
- Use APENAS os slots listados acima. Nunca invente horários fora deles.
- O "start" e "end" de cada bloco devem ser strings ISO exatas dentro do intervalo de um slot.
- Prefira manhãs para conteúdo novo e difícil; tardes para revisão e exercícios.
- Mantenha blocos entre 45min e 90min; divida slots longos se necessário.
- Distribua os tópicos progressivamente: conteúdo novo primeiro, revisões próximas à prova.
- Use aproximadamente ${body.estimatedHoursTotal}h no total (±20% aceitável).
- Se não houver slots suficientes, use os disponíveis e explique no "summary".

Responda APENAS com um JSON válido, sem markdown, sem texto adicional:
{
  "blocks": [
    {
      "title": "Estudo: ${body.subject} – <tópico>",
      "start": "<ISO datetime exato de início, ex: 2026-05-14T08:00:00.000Z>",
      "end": "<ISO datetime exato de fim>",
      "topic": "<tópico específico deste bloco>",
      "description": "<o que estudar neste bloco e como abordar>"
    }
  ],
  "summary": "<resumo: quantas horas planejadas, distribuição dos tópicos, estratégia adotada>"
}`
}

function parseGeminiJson(text: string): GeminiResponse | null {
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  try {
    const parsed = JSON.parse(clean) as GeminiResponse
    if (!Array.isArray(parsed.blocks) || typeof parsed.summary !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

// ── rota ──────────────────────────────────────────────────────────────────────

export async function examRoutes(app: FastifyInstance) {
  app.post<{ Body: ExamPlanBody }>(
    '/api/exam/plan',
    {
      schema: {
        body: {
          type: 'object',
          required: ['subject', 'examDate', 'topics', 'estimatedHoursTotal'],
          properties: {
            subject: { type: 'string', minLength: 1 },
            examDate: { type: 'string' },
            topics: { type: 'array', items: { type: 'string' }, minItems: 1 },
            estimatedHoursTotal: { type: 'number', minimum: 0.5 },
          },
        },
      },
    },
    async (request, reply) => {
      // ── 1. Cliente Calendar ───────────────────────────────────────────────
      let calendar: Awaited<ReturnType<typeof getAuthenticatedCalendar>>
      try {
        calendar = await getAuthenticatedCalendar()
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'NOT_AUTHENTICATED') {
          return reply.status(401).send({ error: 'NOT_AUTHENTICATED' })
        }
        throw err
      }

      // ── 2. Buscar eventos existentes entre agora e examDate ───────────────
      const now = new Date().toISOString()
      const { examDate } = request.body

      const evRes = await calendar.events.list({
        calendarId: 'primary',
        timeMin: now,
        timeMax: examDate,
        singleEvents: true,
        orderBy: 'startTime',
      })

      const existingEvents: MappedEvent[] = (evRes.data.items ?? []).map((ev) => ({
        id: ev.id ?? '',
        title: ev.summary ?? '',
        // Eventos de dia inteiro bloqueiam a janela inteira — mesma convenção de calendar.ts
        start: ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T07:00:00` : ''),
        end: ev.end?.dateTime ?? (ev.end?.date ? `${ev.end.date}T22:00:00` : ''),
        description: '',
      }))

      // ── 3. Calcular slots livres (mínimo 45 min) ──────────────────────────
      const freeSlots = calcFreeSlots(
        existingEvents,
        new Date(now),
        new Date(examDate),
        45 * 60 * 1000,
      )

      app.log.info({ slotsFound: freeSlots.length }, 'Slots livres calculados para o plano')

      // ── 4. Chamar Gemini ──────────────────────────────────────────────────
      let rawText: string
      try {
        rawText = await askGroq(buildExamPrompt(request.body, freeSlots))
      } catch (err: unknown) {
        app.log.error(err, 'Gemini call failed for exam plan')
        const message = err instanceof Error ? err.message : String(err)
        return reply.status(500).send({ error: 'AI_ERROR', message })
      }

      // ── 5. Parsear JSON do Gemini ─────────────────────────────────────────
      const geminiData = parseGeminiJson(rawText)
      if (!geminiData) {
        return reply.status(500).send({ error: 'AI_PARSE_ERROR', raw: rawText })
      }

      app.log.info({ blocksPlanned: geminiData.blocks.length }, 'Plano recebido do Gemini')

      // ── 6. Criar cada bloco no Calendar ───────────────────────────────────
      const createdEvents: MappedEvent[] = []

      for (const block of geminiData.blocks) {
        try {
          const res = await calendar.events.insert({
            calendarId: 'primary',
            requestBody: {
              summary: block.title,
              description: `Tópico: ${block.topic}\n\n${block.description}`,
              start: { dateTime: block.start },
              end: { dateTime: block.end },
            },
          })
          const ev = res.data
          createdEvents.push({
            id: ev.id ?? '',
            title: ev.summary ?? '',
            start: ev.start?.dateTime ?? ev.start?.date ?? '',
            end: ev.end?.dateTime ?? ev.end?.date ?? '',
            description: ev.description ?? '',
          })
        } catch (err) {
          // Loga e pula — não aborta a criação dos demais blocos
          app.log.error({ err, block }, 'Falha ao criar bloco no Calendar')
        }
      }

      // ── 7. Resposta ───────────────────────────────────────────────────────
      return reply.send({
        blocksCreated: createdEvents.length,
        blocks: createdEvents,
        summary: geminiData.summary,
      })
    },
  )
}

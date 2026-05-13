import type { FastifyInstance, FastifyReply } from 'fastify'
import { getAuthenticatedCalendar, loadTokens } from '../lib/tokenStore.js'

// ── tipos internos ──────────────────────────────────────────────────────────

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

// ── helpers ─────────────────────────────────────────────────────────────────

function addDays(date: Date, n: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

/**
 * Calcula horários livres dentro de [dateMin, dateMax], considerando
 * janela de trabalho 07:00–22:00 e duração mínima de minDurationMs ms.
 */
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

    // Limita à janela solicitada pelo caller
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
          slots.push({
            start: new Date(cursor).toISOString(),
            end: new Date(evStart).toISOString(),
          })
        }
        cursor = Math.max(cursor, evEnd)
      }

      // Slot final após o último evento
      if (cursor < rangeEnd.getTime() && rangeEnd.getTime() - cursor >= minDurationMs) {
        slots.push({
          start: new Date(cursor).toISOString(),
          end: rangeEnd.toISOString(),
        })
      }
    }

    day = addDays(day, 1)
  }

  return slots
}

/** Trata NOT_AUTHENTICATED e relança outros erros */
async function withAuth<T>(
  reply: FastifyReply,
  fn: () => Promise<T>,
): Promise<T | void> {
  try {
    return await fn()
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'NOT_AUTHENTICATED') {
      reply.status(401).send({ error: 'NOT_AUTHENTICATED' })
      return
    }
    throw err
  }
}

// ── rotas ────────────────────────────────────────────────────────────────────

export async function calendarRoutes(app: FastifyInstance) {
  // 1. Status ─────────────────────────────────────────────────────────────────
  app.get('/api/calendar/status', async () => {
    const tokens = await loadTokens()
    return { authenticated: tokens !== null }
  })

  // 2. Listar eventos ──────────────────────────────────────────────────────────
  app.get<{ Querystring: { dateMin: string; dateMax: string } }>(
    '/api/calendar/events',
    async (request, reply) => {
      const { dateMin, dateMax } = request.query

      return withAuth(reply, async () => {
        const calendar = await getAuthenticatedCalendar()

        const res = await calendar.events.list({
          calendarId: 'primary',
          timeMin: dateMin,
          timeMax: dateMax,
          singleEvents: true,
          orderBy: 'startTime',
        })

        const events: MappedEvent[] = (res.data.items ?? []).map((ev) => ({
          id: ev.id ?? '',
          title: ev.summary ?? '(sem título)',
          start: ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T00:00:00` : ''),
          end: ev.end?.dateTime ?? (ev.end?.date ? `${ev.end.date}T00:00:00` : ''),
          description: ev.description ?? '',
        }))

        return reply.send(events)
      })
    },
  )

  // 3. Horários livres ─────────────────────────────────────────────────────────
  app.get<{
    Querystring: { dateMin: string; dateMax: string; durationMinutes: string }
  }>('/api/calendar/free-slots', async (request, reply) => {
    const { dateMin, dateMax, durationMinutes } = request.query
    const minDurationMs = (Number(durationMinutes) || 30) * 60 * 1000

    return withAuth(reply, async () => {
      const calendar = await getAuthenticatedCalendar()

      const res = await calendar.events.list({
        calendarId: 'primary',
        timeMin: dateMin,
        timeMax: dateMax,
        singleEvents: true,
        orderBy: 'startTime',
      })

      const events: MappedEvent[] = (res.data.items ?? []).map((ev) => ({
        id: ev.id ?? '',
        title: ev.summary ?? '',
        // Eventos de dia inteiro bloqueiam a janela inteira do dia
        start: ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T07:00:00` : ''),
        end: ev.end?.dateTime ?? (ev.end?.date ? `${ev.end.date}T22:00:00` : ''),
        description: '',
      }))

      const slots = calcFreeSlots(events, new Date(dateMin), new Date(dateMax), minDurationMs)
      return reply.send(slots)
    })
  })

  // 4. Criar evento ────────────────────────────────────────────────────────────
  app.post<{
    Body: { title: string; start: string; end: string; description?: string }
  }>(
    '/api/calendar/events',
    {
      schema: {
        body: {
          type: 'object',
          required: ['title', 'start', 'end'],
          properties: {
            title: { type: 'string' },
            start: { type: 'string' },
            end: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { title, start, end, description } = request.body

      return withAuth(reply, async () => {
        const calendar = await getAuthenticatedCalendar()

        const res = await calendar.events.insert({
          calendarId: 'primary',
          requestBody: {
            summary: title,
            description,
            start: { dateTime: start },
            end: { dateTime: end },
          },
        })

        const ev = res.data
        return reply.status(201).send({
          id: ev.id ?? '',
          title: ev.summary ?? '',
          start: ev.start?.dateTime ?? ev.start?.date ?? '',
          end: ev.end?.dateTime ?? ev.end?.date ?? '',
          description: ev.description ?? '',
        })
      })
    },
  )
}

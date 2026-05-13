import { mkdir, readFile, writeFile } from 'fs/promises'
import path from 'path'
import cron from 'node-cron'
import { askGroq } from '../lib/groqClient.js'
import { getAuthenticatedCalendar } from '../lib/tokenStore.js'

// ── types ──────────────────────────────────────────────────────────────────────

export interface Notification {
  type: 'daily_digest' | 'block_reminder' | 'neglect_alert'
  message: string
  createdAt: string
  read: boolean
}

interface MappedEvent {
  id: string
  title: string
  start: string
  end: string
}

// ── constants ──────────────────────────────────────────────────────────────────

const DATA_DIR = path.join(process.cwd(), 'data')
const NOTIF_FILE = path.join(DATA_DIR, 'notifications.json')
const MAX_NOTIFICATIONS = 50

// ── helpers ────────────────────────────────────────────────────────────────────

function isStudyEvent(title: string): boolean {
  return /^estudo:/i.test(title.trim())
}

function extractSubject(title: string): string {
  // Title format created by exam.ts: "Estudo: Subject – Topic"
  const match = title.match(/^Estudo:\s*([^–\-]+)/i)
  return match ? match[1].trim() : title
}

export async function loadNotifications(): Promise<Notification[]> {
  try {
    const raw = await readFile(NOTIF_FILE, 'utf-8')
    return JSON.parse(raw) as Notification[]
  } catch {
    return []
  }
}

export async function saveNotifications(notifications: Notification[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(NOTIF_FILE, JSON.stringify(notifications.slice(0, MAX_NOTIFICATIONS), null, 2))
}

async function appendNotification(notif: Notification): Promise<void> {
  const existing = await loadNotifications()
  await saveNotifications([notif, ...existing])
}

// ── free-slot algorithm (same as calendar.ts / exam.ts) ──────────────────────

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
): { start: string; end: string }[] {
  const slots: { start: string; end: string }[] = []

  let day = new Date(dateMin)
  day.setHours(0, 0, 0, 0)
  const lastDay = new Date(dateMax)
  lastDay.setHours(0, 0, 0, 0)

  while (day <= lastDay) {
    const workStart = new Date(day); workStart.setHours(7, 0, 0, 0)
    const workEnd = new Date(day); workEnd.setHours(22, 0, 0, 0)
    const rangeStart = new Date(Math.max(workStart.getTime(), dateMin.getTime()))
    const rangeEnd = new Date(Math.min(workEnd.getTime(), dateMax.getTime()))

    if (rangeStart < rangeEnd) {
      const dayEvents = events
        .filter(e => {
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

// ── exported functions ────────────────────────────────────────────────────────

export async function buildDailyDigest(): Promise<string> {
  const calendar = await getAuthenticatedCalendar()

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
  const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999)

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: todayStart.toISOString(),
    timeMax: todayEnd.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  })

  const allEvents = res.data.items ?? []
  const studyEvents = allEvents.filter(ev => isStudyEvent(ev.summary ?? ''))

  const studySummary =
    studyEvents.length === 0
      ? 'Nenhum bloco de estudo agendado para hoje.'
      : studyEvents
          .map(ev => {
            const start = new Date(ev.start?.dateTime ?? '').toLocaleTimeString('pt-BR', {
              hour: '2-digit',
              minute: '2-digit',
            })
            const end = new Date(ev.end?.dateTime ?? '').toLocaleTimeString('pt-BR', {
              hour: '2-digit',
              minute: '2-digit',
            })
            return `- ${ev.summary} (${start}–${end})`
          })
          .join('\n')

  const prompt = `Você é um assistente de estudos. Analise a agenda de hoje e crie um resumo motivador com recomendação de por onde começar.

Blocos de estudo agendados hoje:
${studySummary}

Total de eventos na agenda hoje: ${allEvents.length}

Responda em português, de forma direta e motivadora, em no máximo 3 linhas. Sem bullet points, sem markdown.`

  return askGroq(prompt)
}

export async function buildEndOfBlockReminder(
  eventTitle: string,
  nextFreeSlot: { start: string; end: string } | null,
): Promise<string> {
  const nextSlotText = nextFreeSlot
    ? (() => {
        const start = new Date(nextFreeSlot.start).toLocaleTimeString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit',
        })
        const end = new Date(nextFreeSlot.end).toLocaleTimeString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit',
        })
        const durMin = Math.round(
          (new Date(nextFreeSlot.end).getTime() - new Date(nextFreeSlot.start).getTime()) / 60000,
        )
        return `Próximo slot livre: ${start}–${end} (${durMin} min disponíveis)`
      })()
    : 'Não há mais slots livres disponíveis hoje.'

  const prompt = `Você é um assistente de estudos. Um bloco de estudo acabou de terminar.

Bloco concluído: "${eventTitle}"
${nextSlotText}

Dê uma recomendação curta e direta do que fazer no próximo horário livre. Máximo 2 linhas, em português, sem markdown.`

  return askGroq(prompt)
}

// ── cron jobs ─────────────────────────────────────────────────────────────────

export function scheduleNotifications(): void {
  // Job 1 — Daily digest every day at 07:30
  cron.schedule('30 7 * * *', async () => {
    try {
      const message = await buildDailyDigest()
      await appendNotification({
        type: 'daily_digest',
        message,
        createdAt: new Date().toISOString(),
        read: false,
      })
    } catch (err) {
      console.error('[cron] daily_digest failed:', err)
    }
  })

  // Job 2 — Check completed study blocks every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    try {
      const calendar = await getAuthenticatedCalendar()
      const now = new Date()
      const windowStart = new Date(now.getTime() - 15 * 60 * 1000)

      // Fetch events in the last-15-min window
      const recentRes = await calendar.events.list({
        calendarId: 'primary',
        timeMin: windowStart.toISOString(),
        timeMax: now.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      })

      const justFinished = (recentRes.data.items ?? []).filter(ev => {
        if (!isStudyEvent(ev.summary ?? '')) return false
        const endTime = new Date(ev.end?.dateTime ?? ev.end?.date ?? '').getTime()
        return endTime >= windowStart.getTime() && endTime <= now.getTime()
      })

      if (!justFinished.length) return

      // Fetch remaining events today to calculate free slots
      const dayEnd = new Date(now); dayEnd.setHours(22, 0, 0, 0)
      const futureRes = await calendar.events.list({
        calendarId: 'primary',
        timeMin: now.toISOString(),
        timeMax: dayEnd.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      })

      const futureEvents: MappedEvent[] = (futureRes.data.items ?? []).map(ev => ({
        id: ev.id ?? '',
        title: ev.summary ?? '',
        start: ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T07:00:00` : ''),
        end: ev.end?.dateTime ?? (ev.end?.date ? `${ev.end.date}T22:00:00` : ''),
      }))

      const freeSlots = calcFreeSlots(futureEvents, now, dayEnd, 30 * 60 * 1000)
      const nextSlot = freeSlots[0] ?? null

      for (const ev of justFinished) {
        const message = await buildEndOfBlockReminder(ev.summary ?? '', nextSlot)
        await appendNotification({
          type: 'block_reminder',
          message,
          createdAt: new Date().toISOString(),
          read: false,
        })
      }
    } catch (err) {
      console.error('[cron] block_reminder failed:', err)
    }
  })

  // Job 3 — Neglect alert every day at 20:00
  cron.schedule('0 20 * * *', async () => {
    try {
      const calendar = await getAuthenticatedCalendar()
      const now = new Date()
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000)
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

      const [recentRes, histRes] = await Promise.all([
        calendar.events.list({
          calendarId: 'primary',
          timeMin: threeDaysAgo.toISOString(),
          timeMax: now.toISOString(),
          singleEvents: true,
        }),
        calendar.events.list({
          calendarId: 'primary',
          timeMin: thirtyDaysAgo.toISOString(),
          timeMax: now.toISOString(),
          singleEvents: true,
        }),
      ])

      const studiedRecently = new Set<string>(
        (recentRes.data.items ?? [])
          .filter(ev => isStudyEvent(ev.summary ?? ''))
          .map(ev => extractSubject(ev.summary ?? '')),
      )

      const allKnownSubjects = new Set<string>(
        (histRes.data.items ?? [])
          .filter(ev => isStudyEvent(ev.summary ?? ''))
          .map(ev => extractSubject(ev.summary ?? '')),
      )

      const neglected = [...allKnownSubjects].filter(s => !studiedRecently.has(s))

      for (const subject of neglected) {
        await appendNotification({
          type: 'neglect_alert',
          message: `Você não estudou "${subject}" nos últimos 3 dias. Considere incluir um bloco de revisão.`,
          createdAt: new Date().toISOString(),
          read: false,
        })
      }
    } catch (err) {
      console.error('[cron] neglect_alert failed:', err)
    }
  })
}

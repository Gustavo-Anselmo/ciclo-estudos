import type { FastifyInstance } from 'fastify'
import { loadNotifications, saveNotifications } from '../jobs/notifications.js'

export async function notificationRoutes(app: FastifyInstance) {
  // GET /api/notifications[?unreadOnly=true]
  app.get<{ Querystring: { unreadOnly?: string } }>(
    '/api/notifications',
    async (request, reply) => {
      const { unreadOnly } = request.query
      const notifications = await loadNotifications()

      const filtered =
        unreadOnly === 'true' ? notifications.filter(n => !n.read) : notifications

      // loadNotifications already returns newest-first (prepend on write)
      return reply.send(filtered)
    },
  )

  // PATCH /api/notifications/:index/read
  app.patch<{ Params: { index: string } }>(
    '/api/notifications/:index/read',
    async (request, reply) => {
      const idx = parseInt(request.params.index, 10)

      if (isNaN(idx) || idx < 0) {
        return reply.status(400).send({ error: 'Invalid index' })
      }

      try {
        const notifications = await loadNotifications()

        if (idx >= notifications.length) {
          return reply.status(404).send({ error: 'Notification not found' })
        }

        notifications[idx].read = true
        await saveNotifications(notifications)

        return reply.send(notifications[idx])
      } catch (err) {
        app.log.error(err, 'Failed to update notification')
        return reply.status(500).send({ error: 'FILESYSTEM_ERROR', message: 'Failed to update notification' })
      }
    },
  )
}

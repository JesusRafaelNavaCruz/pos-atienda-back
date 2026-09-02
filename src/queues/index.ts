// src/queues/index.ts
// Definición de colas BullMQ para tareas asíncronas:
//   - stock-alerts: notificaciones de productos con stock bajo
//   - report-generation: generación de reportes pesados en background
//   - emails: correos transaccionales (bienvenida, verificación, etc.)

import { Queue, Worker, QueueEvents } from 'bullmq'
import type { FastifyInstance } from 'fastify'
import { getRedis } from '../lib/redis.js'
import prisma, { tenantStorage } from '../lib/prisma.js'
import { EMAIL_CONFIG } from '../config/email.config.js'
import { EmailService } from '../modules/email/email.service.js'
import type { WelcomeEmailData } from '../modules/email/email.types.js'

// Definición de colas
const connection = { url: process.env.REDIS_URL ?? 'redis://localhost:6379' }

export const stockAlertsQueue = new Queue('stock-alerts', { connection })
export const reportQueue       = new Queue('report-generation', { connection })
export const emailQueue        = new Queue('emails', { connection })

// Tipos de jobs

export interface StockAlertJob {
  tenantId:  string
  productId: string
  name:      string
  stock:     number
  minStock:  number
  unit:      string
}

export interface ReportJob {
  tenantId: string
  userId:   string
  type:     'sales' | 'inventory' | 'cash-cut'
  params:   Record<string, string>
}

// Job de correo: 'type' decide qué template/subject usa el worker.
// Agregar aquí cada nuevo tipo de correo (verification, password-reset, ...).
export type EmailJob =
  | { type: 'welcome'; to: string; data: WelcomeEmailData }

// Worker: alertas de stock bajo

export function createStockAlertsWorker() {
  const worker = new Worker<StockAlertJob>(
    'stock-alerts',
    async (job) => {
      const { tenantId, productId, name, stock, minStock, unit } = job.data

      // En producción: enviar email, push notification, SMS, etc.
      // Aquí se loguea y se podría integrar con SendGrid, Resend, etc.
      console.log(
        `[Stock Alert] Tenant: ${tenantId} | Producto: "${name}" | ` +
        `Stock: ${stock} ${unit} | Mínimo: ${minStock} ${unit}`,
      )

      // Ejemplo de integración con un sistema de notificaciones interno:
      // await sendEmailAlert({ tenantId, productId, name, stock, minStock })

      return { processed: true, productId }
    },
    { connection, concurrency: 5 },
  )

  worker.on('completed', (job) => {
    console.log(`[Queue] Alerta de stock procesada: ${job.id}`)
  })

  worker.on('failed', (job, err) => {
    console.error(`[Queue] Error en alerta de stock ${job?.id}:`, err.message)
  })

  return worker
}

// Worker: correos transaccionales

export function createEmailWorker() {
  const emailService = EmailService.getInstance()

  const worker = new Worker<EmailJob>(
    'emails',
    async (job) => {
      switch (job.data.type) {
        case 'welcome': {
          const { to, data } = job.data
          const loginUrl = `${EMAIL_CONFIG.baseUrl}/login`

          const result = await emailService.sendEmail({
            to,
            templateId: EMAIL_CONFIG.templates.WELCOME,
            templateData: {
              name:       data.name,
              tenantName: data.tenantName,
              ownerName:  data.ownerName,
              ownerEmail: data.ownerEmail,
              planCode:   data.planCode,
              loginUrl,
            },
          })

          if (!result.success) throw result.error ?? new Error('Fallo desconocido al enviar correo')
          return result
        }
        default:
          // Nunca debería pasar mientras EmailJob solo tenga 'welcome';
          // sirve de guarda cuando se agreguen más tipos de correo.
          throw new Error(`Tipo de correo no soportado: ${(job.data as { type: string }).type}`)
      }
    },
    { connection, concurrency: 5 },
  )

  worker.on('completed', (job) => {
    console.log(`[Queue] Correo enviado: ${job.id} (${job.data.type})`)
  })

  worker.on('failed', (job, err) => {
    console.error(`[Queue] Error enviando correo ${job?.id}:`, err.message)
  })

  return worker
}

// Helper: encolar correo de bienvenida tras el registro de un tenant

export async function enqueueWelcomeEmail(to: string, data: WelcomeEmailData) {
  await emailQueue.add(
    'welcome',
    { type: 'welcome', to, data },
    {
      attempts:   3,
      backoff:    { type: 'exponential', delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 50,
    },
  )
}

// Helper: encolar alerta de stock tras una venta

export async function enqueueStockAlertsForSale(
  tenantId: string,
  productIds: string[],
) {
  const products = await tenantStorage.run(tenantId, () =>
    prisma.product.findMany({
      where: {
        id:        { in: productIds },
        tenant_id: tenantId,
        is_active: true,
      },
      select: { id: true, name: true, stock: true, min_stock: true, unit: true },
    }),
  )

  for (const p of products) {
    if (Number(p.stock) <= Number(p.min_stock)) {
      await stockAlertsQueue.add(
        'stock-alert',
        {
          tenantId,
          productId: p.id,
          name:      p.name,
          stock:     Number(p.stock),
          minStock:  Number(p.min_stock),
          unit:      p.unit,
        },
        {
          attempts:   3,
          backoff:    { type: 'exponential', delay: 1000 },
          removeOnComplete: 100,
          removeOnFail: 50,
        },
      )
    }
  }
}

// Plugin de Fastify para inicializar workers

export async function registerQueues(app: FastifyInstance) {
  const stockWorker = createStockAlertsWorker()
  const emailWorker  = createEmailWorker()

  app.addHook('onClose', async () => {
    await stockWorker.close()
    await emailWorker.close()
    await stockAlertsQueue.close()
    await reportQueue.close()
    await emailQueue.close()
  })

  app.log.info('[Queue] Workers de BullMQ iniciados')
}

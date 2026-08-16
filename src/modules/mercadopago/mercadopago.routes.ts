import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { envMP } from '../../config/mercadopago.config.js'
import prisma, { tenantStorage } from '../../lib/prisma.js'
import { MPError } from '../../lib/mercadopago/client.js'
import { OrderService } from '../../lib/mercadopago/order.service.js'
import { TerminalService } from '../../lib/mercadopago/terminal.service.js'
import { getTenantMPAccessToken } from '../../lib/mercadopago/oauth.service.js'
import { requireFeature, requirePermission } from '../../middleware/authorize.js'
import type { JwtPayload } from '../../types/index.js'
import type { Order } from '../../types/mercadopago/types.js'

const checkoutSchema = z.object({
  branch_id: z.string().uuid(),
  terminal_id: z.string().min(3).max(120),
  items: z.array(z.object({ product_id: z.string().uuid(), quantity: z.number().positive() })).min(1),
  customer_id: z.string().uuid().optional(),
  discount: z.number().min(0).default(0),
  notes: z.string().max(1000).optional(),
  description: z.string().max(150).optional(),
  print_on_terminal: z.enum(['seller_ticket', 'no_ticket']).default('seller_ticket'),
  payment_type: z.enum(['credit_card', 'debit_card', 'qr']).optional(),
})

const terminalSchema = z.object({ branch_id: z.string().uuid(), name: z.string().max(200).optional() })
const uuidSchema = z.string().uuid()
const errorResponse = { type: 'object', properties: { success: { type: 'boolean' }, error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } } }

function mpError(reply: any, error: unknown) {
  if (error instanceof MPError) {
    const status = error.status === 0 || error.status >= 500 ? 502 : error.status
    return reply.code(status).send({ success: false, error: { code: 'MERCADOPAGO_ERROR', message: 'No fue posible procesar la solicitud con Mercado Pago' } })
  }
  throw error
}

function verifyWebhookSignature(signature: string | undefined, requestId: string | undefined, dataId: string | undefined) {
  if (!signature || !requestId || !dataId) return false
  const values = Object.fromEntries(signature.split(',').map((part) => {
    const [key, value] = part.trim().split('=')
    return [key, value]
  }))
  if (!values.ts || !values.v1 || !/^\d+$/.test(values.ts)) return false
  // Mitiga replay sin rechazar reintentos legítimos cercanos de Mercado Pago.
  if (Math.abs(Date.now() - Number(values.ts) * 1000) > 5 * 60 * 1000) return false
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${values.ts};`
  const expected = createHmac('sha256', envMP.MP_WEBHOOK_SECRET).update(manifest).digest('hex')
  const received = values.v1
  return expected.length === received.length && timingSafeEqual(Buffer.from(expected), Buffer.from(received))
}

async function nextFolio(tenantId: string) {
  const last = await prisma.sale.findFirst({ where: { tenant_id: tenantId }, orderBy: { created_at: 'desc' }, select: { folio: true } })
  const lastNumber = last ? Number.parseInt(last.folio.replace('VTA-', ''), 10) || 0 : 0
  return `VTA-${String(lastNumber + 1).padStart(6, '0')}`
}

async function synchronizeOrder(order: Order) {
  // El ID de Order viene de Mercado Pago, no del navegador. Se consulta primero
  // y se actualiza únicamente el pago local que lo tiene registrado.
  const payment = await prisma.payment.findUnique({ where: { mercado_pago_order_id: order.id }, include: { sale: { include: { items: true } } } })
  if (!payment) return false

  await tenantStorage.run(payment.tenant_id, () => prisma.$transaction(async (tx) => {
    const current = await tx.payment.findUnique({ where: { id: payment.id }, include: { sale: { include: { items: true } } } })
    if (!current) return
    const transaction = order.transactions.payments[0]
    const update: any = {
      mercado_pago_status: order.status,
      card_last4: transaction?.card?.last_digits ?? undefined,
      card_brand: transaction?.payment_method?.id ?? undefined,
    }
    if (order.status === 'processed') {
      update.status = 'completed'
      await tx.sale.update({ where: { id: current.sale_id }, data: { status: 'completed' } })
    } else if (order.status === 'refunded') {
      update.status = 'refunded'
    } else if (['failed', 'canceled', 'expired'].includes(order.status)) {
      update.status = 'failed'
      // El stock se reservó al iniciar el cobro; se libera una sola vez al fallar.
      if (current.sale.status === 'pending') {
        await Promise.all(current.sale.items.map((item) => tx.product.update({ where: { id: item.product_id }, data: { stock: { increment: item.quantity } } })))
        await tx.sale.update({ where: { id: current.sale_id }, data: { status: 'canceled' } })
      }
    }
    await tx.payment.update({ where: { id: current.id }, data: update })
  }))
  return true
}

export async function mercadoPagoRoutes(app: FastifyInstance) {
  const authHook = async (req: any, reply: any) => { try { await req.jwtVerify() } catch { return reply.code(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Autenticación requerida' } }) } }
  const featureHook = requireFeature('card_payments')

  app.get('/terminals', {
    schema: { tags: ['Mercado Pago'], summary: 'Listar terminales Smart autorizadas', description: 'Devuelve solo las terminales asignadas al tenant autenticado. Requiere el feature card_payments y permiso mercadopago:read.', security: [{ bearerAuth: [] }], response: { 200: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: { type: 'object' } } } }, 403: errorResponse } },
    preHandler: [authHook, featureHook, requirePermission('mercadopago', 'read')],
  }, async (req, reply) => {
    const user = req.user as JwtPayload
    const data = await tenantStorage.run(user.tenantId, () => prisma.mercadoPagoTerminal.findMany({ where: { tenant_id: user.tenantId, is_active: true }, select: { terminal_id: true, name: true, branch_id: true, branch: { select: { name: true } } }, orderBy: { created_at: 'asc' } }))
    return reply.send({ success: true, data })
  })

  app.get('/terminals/available', {
    schema: { tags: ['Mercado Pago'], summary: 'Descubrir terminales de la cuenta conectada', description: 'Solo owner. Consulta las terminales Point de la cuenta OAuth del comercio para seleccionar cuál vincular a una sucursal.', security: [{ bearerAuth: [] }], querystring: { type: 'object', properties: { store_id: { type: 'string' }, pos_id: { type: 'string' } } }, response: { 200: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: { type: 'object' } } } }, 403: errorResponse } },
    preHandler: [authHook, featureHook],
  }, async (req, reply) => {
    const user = req.user as JwtPayload
    if (user.roleCode !== 'owner') return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Solo el owner puede descubrir terminales' } })
    const query = req.query as { store_id?: string; pos_id?: string }
    try {
      const response = await new TerminalService(await getTenantMPAccessToken(user.tenantId)).listTerminals(query)
      const payload: any = response.data
      return reply.send({ success: true, data: payload.data?.terminals ?? payload.terminals ?? [] })
    } catch (error) { return mpError(reply, error) }
  })

  app.put('/terminals/:terminalId', {
    schema: { tags: ['Mercado Pago'], summary: 'Asignar una terminal Smart a una sucursal', description: 'Solo owner. Verifica que la terminal pertenezca a la cuenta Mercado Pago configurada antes de autorizarla para el tenant.', security: [{ bearerAuth: [] }], params: { type: 'object', required: ['terminalId'], properties: { terminalId: { type: 'string' } } }, body: { type: 'object', required: ['branch_id'], properties: { branch_id: { type: 'string', format: 'uuid' }, name: { type: 'string', maxLength: 200 } } }, response: { 200: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object' } } }, 403: errorResponse, 404: errorResponse } },
    preHandler: [authHook, featureHook],
  }, async (req, reply) => {
    const user = req.user as JwtPayload
    if (user.roleCode !== 'owner') return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Solo el owner puede asignar terminales' } })
    const { terminalId } = req.params as { terminalId: string }
    const body = terminalSchema.parse(req.body)
    try {
      const service = new TerminalService(await getTenantMPAccessToken(user.tenantId))
      await service.getTerminal(terminalId)
      await service.setupTerminals([terminalId])
    } catch (error) { return mpError(reply, error) }
    const branch = await tenantStorage.run(user.tenantId, () => prisma.branch.findFirst({ where: { id: body.branch_id, tenant_id: user.tenantId, is_active: true } }))
    if (!branch) return reply.code(404).send({ success: false, error: { code: 'BRANCH_NOT_FOUND', message: 'Sucursal no encontrada o inactiva' } })
    const data = await tenantStorage.run(user.tenantId, () => prisma.mercadoPagoTerminal.upsert({ where: { terminal_id: terminalId }, create: { tenant_id: user.tenantId, branch_id: body.branch_id, terminal_id: terminalId, name: body.name }, update: { branch_id: body.branch_id, name: body.name, is_active: true } }))
    return reply.send({ success: true, data })
  })

  app.post('/orders', {
    schema: { tags: ['Mercado Pago'], summary: 'Iniciar cobro con Terminal Smart', description: 'Crea una venta pendiente, reserva stock y envía una Order a la terminal autorizada. El total se calcula en servidor con el precio actual del catálogo. Enviar un UUID único en Idempotency-Key para reintentos seguros.', security: [{ bearerAuth: [] }], headers: { type: 'object', required: ['idempotency-key'], properties: { 'idempotency-key': { type: 'string', format: 'uuid' } } }, body: { type: 'object', required: ['branch_id', 'terminal_id', 'items'], properties: { branch_id: { type: 'string', format: 'uuid' }, terminal_id: { type: 'string' }, items: { type: 'array', minItems: 1, items: { type: 'object', required: ['product_id', 'quantity'], properties: { product_id: { type: 'string', format: 'uuid' }, quantity: { type: 'number', minimum: 0.001 } } } }, customer_id: { type: 'string', format: 'uuid' }, discount: { type: 'number', minimum: 0 }, notes: { type: 'string' }, description: { type: 'string', maxLength: 150 }, print_on_terminal: { type: 'string', enum: ['seller_ticket', 'no_ticket'] }, payment_type: { type: 'string', enum: ['credit_card', 'debit_card', 'qr'] } } }, response: { 201: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object' } } }, 409: errorResponse, 422: errorResponse, 502: errorResponse } },
    preHandler: [authHook, featureHook, requirePermission('mercadopago', 'create')],
  }, async (req, reply) => {
    const user = req.user as JwtPayload
    const key = uuidSchema.parse(req.headers['idempotency-key'])
    const body = checkoutSchema.parse(req.body)
    if (user.branchId && user.roleCode === 'cashier' && user.branchId !== body.branch_id) return reply.code(403 as any).send({ success: false, error: { code: 'BRANCH_FORBIDDEN', message: 'No puedes cobrar en otra sucursal' } })
    const existing = await tenantStorage.run(user.tenantId, () => prisma.payment.findFirst({ where: { tenant_id: user.tenantId, mercado_pago_idempotency_key: key }, select: { mercado_pago_order_id: true, sale_id: true, amount: true, mercado_pago_status: true } }))
    if (existing?.mercado_pago_order_id) return reply.send({ success: true, data: existing, idempotent: true })
    if (existing) return reply.code(409).send({ success: false, error: { code: 'PAYMENT_IN_PROGRESS', message: 'Ya existe un intento de cobro con esta clave' } })

    const sale = await tenantStorage.run(user.tenantId, () => prisma.$transaction(async (tx) => {
      const terminal = await tx.mercadoPagoTerminal.findFirst({ where: { tenant_id: user.tenantId, branch_id: body.branch_id, terminal_id: body.terminal_id, is_active: true } })
      if (!terminal) throw new Error('TERMINAL_NOT_AUTHORIZED')
      const branch = await tx.branch.findFirst({ where: { id: body.branch_id, tenant_id: user.tenantId, is_active: true } })
      if (!branch) throw new Error('BRANCH_NOT_FOUND')
      const ids = body.items.map((item) => item.product_id)
      if (new Set(ids).size !== ids.length) throw new Error('DUPLICATE_PRODUCT')
      const products = await tx.product.findMany({ where: { id: { in: ids }, tenant_id: user.tenantId, is_active: true } })
      if (products.length !== ids.length) throw new Error('PRODUCT_NOT_FOUND')
      const productMap = new Map(products.map((product) => [product.id, product]))
      let subtotal = 0
      const items = body.items.map((item) => {
        const product = productMap.get(item.product_id)!
        if (!product.sold_by_weight && Number(product.stock) < item.quantity) throw new Error(`INSUFFICIENT_STOCK:${product.name}`)
        const unitPrice = Number(product.price)
        const itemSubtotal = unitPrice * item.quantity
        subtotal += itemSubtotal
        return { product_id: item.product_id, quantity: item.quantity, unit_price: unitPrice, discount: 0, subtotal: itemSubtotal }
      })
      if (body.discount > subtotal) throw new Error('INVALID_DISCOUNT')
      const total = subtotal - body.discount
      const folio = await nextFolio(user.tenantId)
      const created = await tx.sale.create({ data: { tenant_id: user.tenantId, branch_id: body.branch_id, user_id: user.sub, customer_id: body.customer_id, folio, subtotal, discount: body.discount, total, status: 'pending', notes: body.notes, items: { create: items }, payments: { create: { tenant_id: user.tenantId, method: 'card', amount: total, status: 'pending', mercado_pago_terminal_id: body.terminal_id, mercado_pago_status: 'created', mercado_pago_idempotency_key: key } } }, include: { payments: true } })
      await Promise.all(body.items.map((item) => tx.product.update({ where: { id: item.product_id }, data: { stock: { decrement: item.quantity } } })))
      return created
    }))
    try {
      const response = await new OrderService(await getTenantMPAccessToken(user.tenantId)).createOrder({ type: 'point', external_reference: `pos-${sale.id}`, description: body.description ?? `Venta ${sale.folio}`, expiration_time: 'PT15M', transactions: { payments: [{ amount: Number(sale.total).toFixed(2) }] }, config: { point: { terminal_id: body.terminal_id, print_on_terminal: body.print_on_terminal }, payment_method: body.payment_type ? { default_type: body.payment_type } : undefined } }, key)
      const payment = sale.payments[0]
      await tenantStorage.run(user.tenantId, () => prisma.payment.update({ where: { id: payment.id }, data: { mercado_pago_order_id: response.data.id, mercado_pago_status: response.data.status } }))
      return reply.code(201).send({ success: true, data: { sale_id: sale.id, folio: sale.folio, order_id: response.data.id, status: response.data.status, amount: sale.total, expires_in: 'PT15M' } })
    } catch (error) {
      await tenantStorage.run(user.tenantId, () => prisma.$transaction(async (tx) => {
        const current = await tx.sale.findUnique({ where: { id: sale.id }, include: { items: true } })
        if (current?.status === 'pending') {
          await Promise.all(current.items.map((item) => tx.product.update({ where: { id: item.product_id }, data: { stock: { increment: item.quantity } } })))
          await tx.payment.updateMany({ where: { sale_id: sale.id }, data: { status: 'failed', mercado_pago_status: 'creation_failed' } })
          await tx.sale.update({ where: { id: sale.id }, data: { status: 'canceled' } })
        }
      }))
      return mpError(reply, error)
    }
  })

  app.get('/orders/:orderId', { schema: { tags: ['Mercado Pago'], summary: 'Consultar estado de un cobro', security: [{ bearerAuth: [] }], params: { type: 'object', required: ['orderId'], properties: { orderId: { type: 'string', description: 'ID ORD... de Mercado Pago' } } }, response: { 200: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object' } } }, 404: errorResponse } }, preHandler: [authHook, featureHook, requirePermission('mercadopago', 'read')] }, async (req, reply) => {
    const user = req.user as JwtPayload; const { orderId } = req.params as { orderId: string }
    const payment = await tenantStorage.run(user.tenantId, () => prisma.payment.findFirst({ where: { tenant_id: user.tenantId, mercado_pago_order_id: orderId } }))
    if (!payment) return reply.code(404 as any).send({ success: false, error: { code: 'NOT_FOUND', message: 'Cobro no encontrado' } })
    try { const order = (await new OrderService(await getTenantMPAccessToken(user.tenantId)).getOrder(orderId)).data; await synchronizeOrder(order); return reply.send({ success: true, data: order }) } catch (error) { return mpError(reply, error) }
  })

  app.post('/orders/:orderId/cancel', { schema: { tags: ['Mercado Pago'], summary: 'Cancelar cobro pendiente', description: 'Cancela solo una order perteneciente al tenant. force_at_terminal permite cancelar cuando la terminal ya la mostró.', security: [{ bearerAuth: [] }], params: { type: 'object', required: ['orderId'], properties: { orderId: { type: 'string' } } }, body: { type: 'object', properties: { force_at_terminal: { type: 'boolean', default: false } } }, response: { 200: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object' } } }, 404: errorResponse } }, preHandler: [authHook, featureHook, requirePermission('mercadopago', 'cancel')] }, async (req, reply) => {
    const user = req.user as JwtPayload; const { orderId } = req.params as { orderId: string }; const force = z.object({ force_at_terminal: z.boolean().default(false) }).parse(req.body).force_at_terminal
    const payment = await tenantStorage.run(user.tenantId, () => prisma.payment.findFirst({ where: { tenant_id: user.tenantId, mercado_pago_order_id: orderId } }))
    if (!payment) return reply.code(404 as any).send({ success: false, error: { code: 'NOT_FOUND', message: 'Cobro no encontrado' } })
    try { const order = (await new OrderService(await getTenantMPAccessToken(user.tenantId)).cancelOrder(orderId, crypto.randomUUID(), force)).data; await synchronizeOrder(order); return reply.send({ success: true, data: order }) } catch (error) { return mpError(reply, error) }
  })

  app.post('/orders/:orderId/refund', { schema: { tags: ['Mercado Pago'], summary: 'Reembolsar cobro', description: 'Solo manager u owner. El monto es opcional; omitirlo solicita reembolso total.', security: [{ bearerAuth: [] }], params: { type: 'object', required: ['orderId'], properties: { orderId: { type: 'string' } } }, body: { type: 'object', properties: { amount: { type: 'number', minimum: 0.01 } } }, response: { 200: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object' } } }, 404: errorResponse } }, preHandler: [authHook, featureHook, requirePermission('mercadopago', 'refund')] }, async (req, reply) => {
    const user = req.user as JwtPayload; const { orderId } = req.params as { orderId: string }; const amount = z.object({ amount: z.number().positive().optional() }).parse(req.body).amount
    const payment = await tenantStorage.run(user.tenantId, () => prisma.payment.findFirst({ where: { tenant_id: user.tenantId, mercado_pago_order_id: orderId } }))
    if (!payment) return reply.code(404 as any).send({ success: false, error: { code: 'NOT_FOUND', message: 'Cobro no encontrado' } })
    try { const order = (await new OrderService(await getTenantMPAccessToken(user.tenantId)).refundOrder(orderId, crypto.randomUUID(), amount?.toFixed(2))).data; await synchronizeOrder(order); return reply.send({ success: true, data: order }) } catch (error) { return mpError(reply, error) }
  })
}

export async function mercadoPagoWebhookRoutes(app: FastifyInstance) {
  app.post('/mercadopago', {
    schema: {
      tags: ['Mercado Pago'],
      summary: 'Webhook de órdenes Mercado Pago',
      description: 'Endpoint público exclusivo para Mercado Pago. Valida HMAC SHA-256 mediante x-signature y x-request-id; no debe ser invocado por el frontend.',
      response: {
        200: { type: 'object', properties: { received: { type: 'boolean' } } },
        401: errorResponse,
        503: { type: 'object', properties: { received: { type: 'boolean' } } },
      },
    },
  }, async (req, reply) => {
    const query = req.query as { 'data.id'?: string }
    const body = req.body as { data?: { id?: string } }
    const dataId = query['data.id'] ?? body?.data?.id
    const signature = req.headers['x-signature'] as string | undefined
    const requestId = req.headers['x-request-id'] as string | undefined
    if (!verifyWebhookSignature(signature, requestId, dataId)) return reply.code(401).send({ success: false, error: { code: 'INVALID_SIGNATURE', message: 'Firma de webhook inválida' } })
    try {
      const payment = await prisma.payment.findUnique({ where: { mercado_pago_order_id: dataId! } })
      if (!payment) return reply.send({ received: true })
      await synchronizeOrder((await new OrderService(await getTenantMPAccessToken(payment.tenant_id)).getOrder(dataId!)).data)
    } catch (error) { req.log.error(error, 'Mercado Pago webhook synchronization failed'); return reply.code(503 as any).send({ received: false }) }
    return reply.send({ received: true })
  })
}

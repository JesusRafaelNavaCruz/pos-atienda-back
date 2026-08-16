// src/modules/suppliers/purchase-orders.routes.ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import prisma, { tenantStorage } from '../../lib/prisma.js'
import { requireFeature, requirePermission } from '../../middleware/authorize.js'
import type { JwtPayload } from '../../types/index.js'

// ─── Schemas ──────────────────────────────────────────────────────────────────

const itemSchema = z.object({
  product_id: z.string().uuid(),
  quantity:   z.number().positive(),
  unit_cost:  z.number().min(0),
})

const createSchema = z.object({
  supplier_id: z.string().uuid(),
  branch_id:   z.string().uuid().optional(),
  expected_at: z.string().optional(),
  notes:       z.string().optional(),
  items:       z.array(itemSchema).min(1, 'La orden debe tener al menos un producto'),
})

const listQuerySchema = z.object({
  page:        z.coerce.number().min(1).default(1),
  limit:       z.coerce.number().min(1).max(100).default(20),
  supplier_id: z.string().uuid().optional(),
  status:      z.enum(['draft', 'sent', 'received', 'canceled']).optional(),
  from:        z.string().optional(),
  to:          z.string().optional(),
})

// ─── Shared fragments ─────────────────────────────────────────────────────────

const errorResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    error: {
      type: 'object',
      properties: { code: { type: 'string' }, message: { type: 'string' } },
    },
  },
}

const orderProperties = {
  id:          { type: 'string' },
  folio:       { type: 'string' },
  status:      { type: 'string' },
  total:       { type: 'number' },
  notes:       { type: 'string', nullable: true },
  expected_at: { type: 'string', nullable: true },
  received_at: { type: 'string', nullable: true },
  created_at:  { type: 'string', format: 'date-time' },
  supplier:    { type: 'object', nullable: true },
  user:        { type: 'object', nullable: true },
  branch:      { type: 'object', nullable: true },
  items:       { type: 'array',  items: { type: 'object' } },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function generateFolio(tenantId: string, tx: any): Promise<string> {
  const count = await tx.purchaseOrder.count({ where: { tenant_id: tenantId } })
  return `OC-${String(count + 1).padStart(6, '0')}`
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function purchaseOrdersRoutes(app: FastifyInstance) {
  const authHook = async (req: any, rep: any) => {
    try { await req.jwtVerify() } catch { return rep.code(401).send() }
  }

  // Todos los endpoints requieren el feature 'suppliers'
  const featureHook = requireFeature('suppliers')

  // ── GET /purchase-orders/suggest ────────────────────────────────────────────
  // Debe ir ANTES de /:id para que Fastify no lo interprete como un ID
  app.get('/suggest', {
    schema: {
      tags: ['Purchase Orders'],
      summary: 'Sugerir items para orden de compra',
      description:
        'Retorna los productos con stock bajo (stock ≤ min_stock) del proveedor indicado, con la cantidad sugerida a pedir.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        required: ['supplier_id'],
        properties: {
          supplier_id: { type: 'string', format: 'uuid', description: 'Proveedor a consultar' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  product_id:      { type: 'string' },
                  name:            { type: 'string' },
                  barcode:         { type: 'string', nullable: true },
                  unit:            { type: 'string' },
                  current_stock:   { type: 'number' },
                  min_stock:       { type: 'number' },
                  suggested_qty:   { type: 'number' },
                  last_cost:       { type: 'number' },
                },
              },
            },
          },
        },
        404: { description: 'Proveedor no encontrado', ...errorResponse },
      },
    },
    preHandler: [authHook, featureHook, requirePermission('purchase_orders', 'read')],
  }, async (req, res) => {
    const user = req.user as JwtPayload
    const { supplier_id } = z.object({ supplier_id: z.string().uuid() }).parse(req.query)

    const supplier = await tenantStorage.run(user.tenantId, () =>
      prisma.supplier.findFirst({ where: { id: supplier_id, tenant_id: user.tenantId } }),
    )
    if (!supplier) {
      return res.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Proveedor no encontrado' },
      })
    }

    const products = await tenantStorage.run(user.tenantId, () =>
      prisma.$queryRaw<any[]>`
        SELECT
          p.id          AS product_id,
          p.name,
          p.barcode,
          p.unit,
          p.stock::float            AS current_stock,
          p.min_stock::float        AS min_stock,
          -- Sugerido: llenar hasta el doble del mínimo, mínimo 1 unidad
          GREATEST(1, (p.min_stock * 2 - p.stock)::float)  AS suggested_qty,
          p.cost::float             AS last_cost
        FROM negocio.products p
        WHERE p.tenant_id   = ${user.tenantId}::uuid
          AND p.supplier_id = ${supplier_id}::uuid
          AND p.is_active   = true
          AND p.stock       <= p.min_stock
        ORDER BY (p.min_stock - p.stock) DESC
      `,
    )

    return res.send({ success: true, data: products })
  })

  // ── GET /purchase-orders ─────────────────────────────────────────────────────
  app.get('/', {
    schema: {
      tags: ['Purchase Orders'],
      summary: 'Listar órdenes de compra',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          page:        { type: 'integer', minimum: 1, default: 1 },
          limit:       { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          supplier_id: { type: 'string', format: 'uuid' },
          status:      { type: 'string', enum: ['draft', 'sent', 'received', 'canceled'] },
          from:        { type: 'string', format: 'date-time' },
          to:          { type: 'string', format: 'date-time' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id:          { type: 'string' },
                  folio:       { type: 'string' },
                  status:      { type: 'string' },
                  total:       { type: 'number' },
                  expected_at: { type: 'string', nullable: true },
                  received_at: { type: 'string', nullable: true },
                  created_at:  { type: 'string', format: 'date-time' },
                  supplier:    { type: 'object' },
                  _count:      { type: 'object' },
                },
              },
            },
            meta: {
              type: 'object',
              properties: {
                page:       { type: 'integer' },
                limit:      { type: 'integer' },
                total:      { type: 'integer' },
                totalPages: { type: 'integer' },
              },
            },
          },
        },
      },
    },
    preHandler: [authHook, featureHook, requirePermission('purchase_orders', 'read')],
  }, async (req, res) => {
    const user = req.user as JwtPayload
    const { page, limit, supplier_id, status, from, to } = listQuerySchema.parse(req.query)

    const where: any = { tenant_id: user.tenantId }
    if (supplier_id) where.supplier_id = supplier_id
    if (status) where.status = status
    if (from || to) {
      where.created_at = {}
      if (from) where.created_at.gte = new Date(from)
      if (to)   where.created_at.lte = new Date(to)
    }

    const [orders, total] = await tenantStorage.run(user.tenantId, () =>
      Promise.all([
        prisma.purchaseOrder.findMany({
          where,
          include: {
            supplier: { select: { id: true, name: true, phone: true } },
            _count:   { select: { items: true } },
          },
          orderBy: { created_at: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.purchaseOrder.count({ where }),
      ]),
    )

    return res.send({
      success: true,
      data: orders,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    })
  })

  // ── GET /purchase-orders/:id ─────────────────────────────────────────────────
  app.get('/:id', {
    schema: {
      tags: ['Purchase Orders'],
      summary: 'Detalle de orden de compra',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      response: {
        200: {
          type: 'object',
          properties: { success: { type: 'boolean' }, data: { type: 'object', properties: orderProperties } },
        },
        404: { description: 'Orden no encontrada', ...errorResponse },
      },
    },
    preHandler: [authHook, featureHook, requirePermission('purchase_orders', 'read')],
  }, async (req, res) => {
    const user = req.user as JwtPayload
    const { id } = req.params as { id: string }

    const order = await tenantStorage.run(user.tenantId, () =>
      prisma.purchaseOrder.findFirst({
        where: { id, tenant_id: user.tenantId },
        include: {
          supplier: true,
          user:     { select: { id: true, full_name: true } },
          branch:   { select: { id: true, name: true } },
          items: {
            include: {
              product: { select: { id: true, name: true, barcode: true, unit: true, stock: true } },
            },
          },
        },
      }),
    )

    if (!order) {
      return res.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Orden de compra no encontrada' },
      })
    }

    return res.send({ success: true, data: order })
  })

  // ── POST /purchase-orders ────────────────────────────────────────────────────
  app.post('/', {
    schema: {
      tags: ['Purchase Orders'],
      summary: 'Crear orden de compra',
      description: 'Crea una orden en estado `draft`. Los items deben ser productos del proveedor indicado.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['supplier_id', 'items'],
        properties: {
          supplier_id: { type: 'string', format: 'uuid' },
          branch_id:   { type: 'string', format: 'uuid' },
          expected_at: { type: 'string', format: 'date', description: 'Fecha esperada de entrega (YYYY-MM-DD)' },
          notes:       { type: 'string' },
          items: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['product_id', 'quantity', 'unit_cost'],
              properties: {
                product_id: { type: 'string', format: 'uuid' },
                quantity:   { type: 'number', minimum: 0.001 },
                unit_cost:  { type: 'number', minimum: 0 },
              },
            },
          },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: { success: { type: 'boolean' }, data: { type: 'object', properties: orderProperties } },
        },
        404: { description: 'Proveedor o producto no encontrado', ...errorResponse },
      },
    },
    preHandler: [authHook, featureHook, requirePermission('purchase_orders', 'create')],
  }, async (req, res) => {
    const user = req.user as JwtPayload
    const body = createSchema.parse(req.body)

    const order = await tenantStorage.run(user.tenantId, () =>
      prisma.$transaction(async (tx) => {
        // Validar proveedor
        const supplier = await tx.supplier.findFirst({
          where: { id: body.supplier_id, tenant_id: user.tenantId, is_active: true },
        })
        if (!supplier) throw Object.assign(new Error('Proveedor no encontrado'), { code: 'NOT_FOUND' })

        // Validar que todos los productos pertenecen al tenant
        const productIds = body.items.map((i) => i.product_id)
        const products = await tx.product.findMany({
          where: { id: { in: productIds }, tenant_id: user.tenantId, is_active: true },
          select: { id: true, name: true },
        })
        if (products.length !== productIds.length) {
          const found = products.map((p) => p.id)
          const missing = productIds.filter((id) => !found.includes(id))
          throw Object.assign(
            new Error(`Productos no encontrados: ${missing.join(', ')}`),
            { code: 'NOT_FOUND' },
          )
        }

        // Calcular subtotales y total
        const itemsData = body.items.map((item) => ({
          product_id: item.product_id,
          quantity:   item.quantity,
          unit_cost:  item.unit_cost,
          subtotal:   item.quantity * item.unit_cost,
        }))
        const total = itemsData.reduce((sum, i) => sum + i.subtotal, 0)

        const folio = await generateFolio(user.tenantId, tx)

        return tx.purchaseOrder.create({
          data: {
            tenant_id:   user.tenantId,
            supplier_id: body.supplier_id,
            user_id:     user.sub,
            branch_id:   body.branch_id ?? user.branchId ?? null,
            folio,
            total,
            notes:       body.notes,
            expected_at: body.expected_at ? new Date(body.expected_at) : null,
            items: { create: itemsData },
          },
          include: {
            supplier: true,
            user:     { select: { id: true, full_name: true } },
            branch:   { select: { id: true, name: true } },
            items: {
              include: {
                product: { select: { id: true, name: true, barcode: true, unit: true, stock: true } },
              },
            },
          },
        })
      }),
    )

    return res.code(201).send({ success: true, data: order })
  })

  // ── PATCH /purchase-orders/:id/send ─────────────────────────────────────────
  app.patch('/:id/send', {
    schema: {
      tags: ['Purchase Orders'],
      summary: 'Enviar orden al proveedor',
      description: 'Cambia el estado de `draft` a `sent`. Representa que la orden fue comunicada al proveedor.',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      response: {
        200: {
          type: 'object',
          properties: { success: { type: 'boolean' }, data: { type: 'object', properties: orderProperties } },
        },
        400: { description: 'La orden no está en estado draft', ...errorResponse },
        404: { description: 'Orden no encontrada', ...errorResponse },
      },
    },
    preHandler: [authHook, featureHook, requirePermission('purchase_orders', 'update')],
  }, async (req, res) => {
    const user = req.user as JwtPayload
    const { id } = req.params as { id: string }

    const existing = await tenantStorage.run(user.tenantId, () =>
      prisma.purchaseOrder.findFirst({ where: { id, tenant_id: user.tenantId } }),
    )
    if (!existing) {
      return res.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Orden no encontrada' } })
    }
    if (existing.status !== 'draft') {
      return res.code(400).send({
        success: false,
        error: { code: 'INVALID_STATUS', message: `Solo se puede enviar una orden en estado draft (actual: ${existing.status})` },
      })
    }

    const order = await tenantStorage.run(user.tenantId, () =>
      prisma.purchaseOrder.update({
        where: { id },
        data: { status: 'sent' },
        include: {
          supplier: true,
          user:     { select: { id: true, full_name: true } },
          branch:   { select: { id: true, name: true } },
          items: {
            include: {
              product: { select: { id: true, name: true, barcode: true, unit: true, stock: true } },
            },
          },
        },
      }),
    )

    return res.send({ success: true, data: order })
  })

  // ── PATCH /purchase-orders/:id/receive ──────────────────────────────────────
  app.patch('/:id/receive', {
    schema: {
      tags: ['Purchase Orders'],
      summary: 'Registrar recepción de mercancía',
      description: `Marca la orden como \`received\` y actualiza el inventario automáticamente:
- Suma la cantidad de cada item al stock del producto
- Registra un movimiento de inventario tipo \`purchase\` ligado a esta orden
- Actualiza el costo (\`cost\`) del producto con el \`unit_cost\` del item`,
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      response: {
        200: {
          type: 'object',
          properties: { success: { type: 'boolean' }, data: { type: 'object', properties: orderProperties } },
        },
        400: { description: 'La orden no está en estado enviable', ...errorResponse },
        404: { description: 'Orden no encontrada', ...errorResponse },
      },
    },
    preHandler: [authHook, featureHook, requirePermission('purchase_orders', 'update')],
  }, async (req, res) => {
    const user = req.user as JwtPayload
    const { id } = req.params as { id: string }

    const order = await tenantStorage.run(user.tenantId, () =>
      prisma.$transaction(async (tx) => {
        const existing = await tx.purchaseOrder.findFirst({
          where: { id, tenant_id: user.tenantId },
          include: { items: true },
        })

        if (!existing) throw Object.assign(new Error('Orden no encontrada'), { code: 'NOT_FOUND' })

        if (existing.status === 'received') {
          throw Object.assign(new Error('Esta orden ya fue recibida'), { code: 'ALREADY_RECEIVED' })
        }
        if (existing.status === 'canceled') {
          throw Object.assign(new Error('No se puede recibir una orden cancelada'), { code: 'INVALID_STATUS' })
        }

        // Para cada item: actualizar stock, registrar movimiento e historizar costo
        for (const item of existing.items) {
          const product = await tx.product.findUnique({
            where: { id: item.product_id },
            select: { stock: true },
          })
          if (!product) continue

          const before  = Number(product.stock)
          const delta   = Number(item.quantity)
          const after   = before + delta

          await tx.product.update({
            where: { id: item.product_id },
            data:  { stock: after, cost: item.unit_cost },
          })

          await tx.inventoryMovement.create({
            data: {
              tenant_id:       user.tenantId,
              product_id:      item.product_id,
              user_id:         user.sub,
              branch_id:       existing.branch_id,
              type:            'purchase',
              quantity_before: before,
              quantity_after:  after,
              delta:           delta,
              reason:          `Recepción OC ${existing.folio}`,
              reference_id:    existing.id,
            },
          })
        }

        return tx.purchaseOrder.update({
          where: { id },
          data:  { status: 'received', received_at: new Date() },
          include: {
            supplier: true,
            user:     { select: { id: true, full_name: true } },
            branch:   { select: { id: true, name: true } },
            items: {
              include: {
                product: { select: { id: true, name: true, barcode: true, unit: true, stock: true } },
              },
            },
          },
        })
      }),
    )

    return res.send({ success: true, data: order })
  })

  // ── PATCH /purchase-orders/:id/cancel ───────────────────────────────────────
  app.patch('/:id/cancel', {
    schema: {
      tags: ['Purchase Orders'],
      summary: 'Cancelar orden de compra',
      description: 'Cancela una orden en estado `draft` o `sent`. Las órdenes recibidas no se pueden cancelar.',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', properties: { message: { type: 'string' }, folio: { type: 'string' } } },
          },
        },
        400: { description: 'La orden no se puede cancelar', ...errorResponse },
        404: { description: 'Orden no encontrada', ...errorResponse },
      },
    },
    preHandler: [authHook, featureHook, requirePermission('purchase_orders', 'update')],
  }, async (req, res) => {
    const user = req.user as JwtPayload
    const { id } = req.params as { id: string }

    const existing = await tenantStorage.run(user.tenantId, () =>
      prisma.purchaseOrder.findFirst({ where: { id, tenant_id: user.tenantId } }),
    )
    if (!existing) {
      return res.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Orden no encontrada' } })
    }
    if (existing.status === 'received') {
      return res.code(400).send({
        success: false,
        error: { code: 'INVALID_STATUS', message: 'No se puede cancelar una orden ya recibida' },
      })
    }
    if (existing.status === 'canceled') {
      return res.code(400).send({
        success: false,
        error: { code: 'ALREADY_CANCELED', message: 'La orden ya está cancelada' },
      })
    }

    await tenantStorage.run(user.tenantId, () =>
      prisma.purchaseOrder.update({ where: { id }, data: { status: 'canceled' } }),
    )

    return res.send({
      success: true,
      data: { message: `Orden ${existing.folio} cancelada`, folio: existing.folio },
    })
  })
}

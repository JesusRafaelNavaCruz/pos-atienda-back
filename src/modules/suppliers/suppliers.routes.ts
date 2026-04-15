// src/modules/suppliers/suppliers.routes.ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import prisma, { tenantStorage } from '../../lib/prisma.js'
import { requirePermission, requireFeature } from '../../middleware/authorize.js'
import type { JwtPayload } from '../../types/index.js'

const supplierSchema = z.object({
  name:         z.string().min(1).max(200),
  contact_name: z.string().max(200).optional(),
  phone:        z.string().max(30).optional(),
  email:        z.string().email().optional(),
  rfc:          z.string().max(13).optional(),
  address:      z.string().optional(),
  notes:        z.string().optional(),
})

const querySchema = z.object({
  page:    z.coerce.number().min(1).default(1),
  limit:   z.coerce.number().min(1).max(100).default(20),
  search:  z.string().optional(),
  sortBy:  z.enum(['name', 'created_at']).default('name'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
})

// ─── Shared schema fragments ───────────────────────────────────────────────────
const supplierProperties = {
  id: { type: 'string' },
  name: { type: 'string' },
  contact_name: { type: 'string', nullable: true },
  phone: { type: 'string', nullable: true },
  email: { type: 'string', nullable: true },
  rfc: { type: 'string', nullable: true },
  address: { type: 'string', nullable: true },
  notes: { type: 'string', nullable: true },
  is_active: { type: 'boolean' },
  created_at: { type: 'string', format: 'date-time' },
}

const errorResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
    },
  },
}

export async function suppliersRoutes(app: FastifyInstance) {
  const authHook = async (req: any, rep: any) => {
    try { await req.jwtVerify() } catch { return rep.code(401).send() }
  }

  // Todos los endpoints de proveedores requieren el feature 'suppliers'
  const featureHook = requireFeature('suppliers')

  // GET /suppliers
  app.get('/', {
    schema: {
      tags: ['Suppliers'],
      summary: 'Listar proveedores',
      description:
        'Retorna la lista paginada de proveedores activos del tenant. Requiere el feature `suppliers` en el plan.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          search: {
            type: 'string',
            description: 'Buscar por nombre, nombre de contacto o RFC',
          },
          sortBy: { type: 'string', enum: ['name', 'created_at'], default: 'name' },
          sortOrder: { type: 'string', enum: ['asc', 'desc'], default: 'asc' },
        },
      },
      response: {
        200: {
          description: 'Lista de proveedores',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'array',
              items: { type: 'object', properties: supplierProperties },
            },
            meta: {
              type: 'object',
              properties: {
                page: { type: 'integer' },
                limit: { type: 'integer' },
                total: { type: 'integer' },
                totalPages: { type: 'integer' },
              },
            },
          },
        },
      },
    },
    preHandler: [authHook, featureHook, requirePermission('suppliers', 'read')],
  }, async (req, res) => {
    const user = req.user as JwtPayload
    const { page, limit, search, sortBy, sortOrder } = querySchema.parse(req.query)

    const where: any = { tenant_id: user.tenantId, is_active: true }
    if (search) {
      where.OR = [
        { name:         { contains: search, mode: 'insensitive' } },
        { contact_name: { contains: search, mode: 'insensitive' } },
        { rfc:          { contains: search, mode: 'insensitive' } },
      ]
    }

    const [suppliers, total] = await tenantStorage.run(user.tenantId, () =>
      Promise.all([
        prisma.supplier.findMany({
          where,
          include: { _count: { select: { products: true, purchase_orders: true } } },
          orderBy: { [sortBy]: sortOrder },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.supplier.count({ where }),
      ]),
    )

    return res.send({
      success: true,
      data: suppliers,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    })
  })

  // GET /suppliers/:id
  app.get('/:id', {
    schema: {
      tags: ['Suppliers'],
      summary: 'Obtener proveedor por ID',
      description:
        'Retorna el detalle del proveedor con los primeros 20 productos activos asociados y sus últimas 10 órdenes de compra.',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
      response: {
        200: {
          description: 'Detalle del proveedor',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                ...supplierProperties,
                products: { type: 'array', items: { type: 'object' } },
                purchase_orders: { type: 'array', items: { type: 'object' } },
              },
            },
          },
        },
        404: { description: 'Proveedor no encontrado', ...errorResponse },
      },
    },
    preHandler: [authHook, featureHook, requirePermission('suppliers', 'read')],
  }, async (req, res) => {
    const user = req.user as JwtPayload
    const { id } = req.params as { id: string }

    const supplier = await tenantStorage.run(user.tenantId, () =>
      prisma.supplier.findFirst({
        where: { id, tenant_id: user.tenantId },
        include: {
          products: {
            where: { is_active: true },
            select: { id: true, name: true, barcode: true, price: true, stock: true },
            take: 20,
          },
          purchase_orders: {
            orderBy: { created_at: 'desc' },
            take: 10,
            select: { id: true, folio: true, status: true, total: true, created_at: true },
          },
        },
      }),
    )

    if (!supplier) {
      return res.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Proveedor no encontrado' },
      })
    }

    return res.send({ success: true, data: supplier })
  })

  // POST /suppliers
  app.post('/', {
    schema: {
      tags: ['Suppliers'],
      summary: 'Crear proveedor',
      description: 'Registra un nuevo proveedor en el tenant.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          contact_name: { type: 'string', maxLength: 200 },
          phone: { type: 'string', maxLength: 30 },
          email: { type: 'string', format: 'email' },
          rfc: { type: 'string', maxLength: 13 },
          address: { type: 'string' },
          notes: { type: 'string' },
        },
      },
      response: {
        201: {
          description: 'Proveedor creado exitosamente',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', properties: supplierProperties },
          },
        },
      },
    },
    preHandler: [authHook, featureHook, requirePermission('suppliers', 'create')],
  }, async (req, res) => {
    const user  = req.user as JwtPayload
    const body  = supplierSchema.parse(req.body)

    const supplier = await tenantStorage.run(user.tenantId, () =>
      prisma.supplier.create({ data: { ...body, tenant_id: user.tenantId } }),
    )

    return res.code(201).send({ success: true, data: supplier })
  })

  // PUT /suppliers/:id
  app.put('/:id', {
    schema: {
      tags: ['Suppliers'],
      summary: 'Actualizar proveedor',
      description: 'Actualiza parcialmente los datos de un proveedor.',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          contact_name: { type: 'string', maxLength: 200 },
          phone: { type: 'string', maxLength: 30 },
          email: { type: 'string', format: 'email' },
          rfc: { type: 'string', maxLength: 13 },
          address: { type: 'string' },
          notes: { type: 'string' },
        },
      },
      response: {
        200: {
          description: 'Proveedor actualizado',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', properties: supplierProperties },
          },
        },
        404: { description: 'Proveedor no encontrado', ...errorResponse },
      },
    },
    preHandler: [authHook, featureHook, requirePermission('suppliers', 'update')],
  }, async (req, res) => {
    const user = req.user as JwtPayload
    const { id } = req.params as { id: string }
    const body = supplierSchema.partial().parse(req.body)

    const existing = await tenantStorage.run(user.tenantId, () =>
      prisma.supplier.findFirst({ where: { id, tenant_id: user.tenantId } }),
    )
    if (!existing) {
      return res.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Proveedor no encontrado' },
      })
    }

    const supplier = await tenantStorage.run(user.tenantId, () =>
      prisma.supplier.update({ where: { id }, data: body }),
    )

    return res.send({ success: true, data: supplier })
  })

  // DELETE /suppliers/:id — soft delete
  app.delete('/:id', {
    schema: {
      tags: ['Suppliers'],
      summary: 'Desactivar proveedor',
      description: 'Realiza un soft delete del proveedor (is_active = false).',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
      response: {
        200: {
          description: 'Proveedor desactivado',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: { message: { type: 'string' } },
            },
          },
        },
        404: { description: 'Proveedor no encontrado', ...errorResponse },
      },
    },
    preHandler: [authHook, featureHook, requirePermission('suppliers', 'delete')],
  }, async (req, res) => {
    const user = req.user as JwtPayload
    const { id } = req.params as { id: string }

    const existing = await tenantStorage.run(user.tenantId, () =>
      prisma.supplier.findFirst({ where: { id, tenant_id: user.tenantId } }),
    )
    if (!existing) {
      return res.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Proveedor no encontrado' },
      })
    }

    await tenantStorage.run(user.tenantId, () =>
      prisma.supplier.update({ where: { id }, data: { is_active: false } }),
    )

    return res.send({ success: true, data: { message: 'Proveedor desactivado' } })
  })
}

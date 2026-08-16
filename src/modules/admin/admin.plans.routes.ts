// src/modules/admin/admin.plans.routes.ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import prisma from '../../lib/prisma.js'
import { featureCache } from '../../lib/redis.js'
import { requireSuperAdmin } from '../../middleware/authorize.js'

const authHook = async (req: any, rep: any) => {
  try { await req.jwtVerify() } catch { return rep.code(401).send() }
}

const planBodySchema = z.object({
  name:             z.string().min(2).max(100),
  code:             z.string().min(2).max(50).regex(/^[a-z0-9_]+$/, 'Solo letras minúsculas, números y _'),
  price_mxn:        z.number().positive(),
  billing_interval: z.enum(['monthly', 'yearly']).default('monthly'),
  max_users:        z.number().int().min(1),
  max_branches:     z.number().int().min(1),
  trial_days:       z.number().int().min(0).default(14),
  is_active:        z.boolean().default(true),
})

const updatePlanSchema = z.object({
  name:             z.string().min(2).max(100).optional(),
  price_mxn:        z.number().positive().optional(),
  billing_interval: z.enum(['monthly', 'yearly']).optional(),
  max_users:        z.number().int().min(1).optional(),
  max_branches:     z.number().int().min(1).optional(),
  trial_days:       z.number().int().min(0).optional(),
  is_active:        z.boolean().optional(),
})

const featureBodySchema = z.object({
  feature_key:  z.string().min(1).max(100),
  limit_value:  z.string().default('true'),
})

const errorSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    error: {
      type: 'object',
      properties: { code: { type: 'string' }, message: { type: 'string' } },
    },
  },
} as const

const planProps = {
  id:               { type: 'string' },
  name:             { type: 'string' },
  code:             { type: 'string' },
  price_mxn:        { type: 'number' },
  billing_interval: { type: 'string' },
  max_users:        { type: 'integer' },
  max_branches:     { type: 'integer' },
  trial_days:       { type: 'integer' },
  is_active:        { type: 'boolean' },
  created_at:       { type: 'string', format: 'date-time' },
  features: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id:          { type: 'string' },
        feature_key: { type: 'string' },
        limit_value: { type: 'string' },
      },
    },
  },
}

async function invalidatePlanCache(planId: string) {
  const subs = await prisma.subscription.findMany({
    where: { plan_id: planId, status: { in: ['active', 'trialing'] } },
    select: { tenant_id: true },
  })
  await Promise.all(subs.map(s => featureCache.del(s.tenant_id)))
}

export async function adminPlansRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authHook)
  app.addHook('preHandler', requireSuperAdmin())

  // GET /admin/plans — listar todos los planes
  app.get('/', {
    schema: {
      tags: ['Admin — Planes'],
      summary: 'Listar planes',
      description: 'Retorna todos los planes con sus features. Por defecto solo los activos.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          include_inactive: { type: 'boolean', default: false, description: 'Incluir planes desactivados' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'array', items: { type: 'object', properties: planProps } },
          },
        },
      },
    },
  }, async (req, res) => {
    const { include_inactive = false } = req.query as { include_inactive?: boolean }

    const plans = await prisma.plan.findMany({
      where: include_inactive ? {} : { is_active: true },
      include: { features: true, _count: { select: { subscriptions: true } } },
      orderBy: { price_mxn: 'asc' },
    })

    return res.send({
      success: true,
      data: plans.map(p => ({ ...p, price_mxn: Number(p.price_mxn) })),
    })
  })

  // GET /admin/plans/:id — detalle de un plan
  app.get('/:id', {
    schema: {
      tags: ['Admin — Planes'],
      summary: 'Detalle de un plan',
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
            data: { type: 'object', properties: planProps, additionalProperties: true },
          },
        },
        404: errorSchema,
      },
    },
  }, async (req, res) => {
    const { id } = req.params as { id: string }

    const plan = await prisma.plan.findUnique({
      where: { id },
      include: { features: true, _count: { select: { subscriptions: true } } },
    })

    if (!plan) {
      return res.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Plan no encontrado' },
      })
    }

    return res.send({
      success: true,
      data: { ...plan, price_mxn: Number(plan.price_mxn) },
    })
  })

  // POST /admin/plans — crear un nuevo plan
  app.post('/', {
    schema: {
      tags: ['Admin — Planes'],
      summary: 'Crear plan',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['name', 'code', 'price_mxn', 'max_users', 'max_branches'],
        properties: {
          name:             { type: 'string', minLength: 2, maxLength: 100 },
          code:             { type: 'string', description: 'Identificador único: solo minúsculas, números y _' },
          price_mxn:        { type: 'number', minimum: 0 },
          billing_interval: { type: 'string', enum: ['monthly', 'yearly'] },
          max_users:        { type: 'integer', minimum: 1 },
          max_branches:     { type: 'integer', minimum: 1 },
          trial_days:       { type: 'integer', minimum: 0, default: 14 },
          is_active:        { type: 'boolean', default: true },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', properties: planProps },
          },
        },
        409: errorSchema,
      },
    },
  }, async (req, res) => {
    const body = planBodySchema.parse(req.body)

    const existing = await prisma.plan.findUnique({ where: { code: body.code } })
    if (existing) {
      return res.code(409).send({
        success: false,
        error: { code: 'CONFLICT', message: 'Ya existe un plan con ese código' },
      })
    }

    const plan = await prisma.plan.create({
      data: body,
      include: { features: true },
    })

    return res.code(201).send({
      success: true,
      data: { ...plan, price_mxn: Number(plan.price_mxn) },
    })
  })

  // PUT /admin/plans/:id — actualizar un plan
  app.put('/:id', {
    schema: {
      tags: ['Admin — Planes'],
      summary: 'Actualizar plan',
      description: 'Actualiza precio, nombre, límites o período de prueba. Los cambios no afectan suscripciones Stripe activas hasta su próxima renovación.',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      body: {
        type: 'object',
        properties: {
          name:             { type: 'string', minLength: 2, maxLength: 100 },
          price_mxn:        { type: 'number', minimum: 0 },
          billing_interval: { type: 'string', enum: ['monthly', 'yearly'] },
          max_users:        { type: 'integer', minimum: 1 },
          max_branches:     { type: 'integer', minimum: 1 },
          trial_days:       { type: 'integer', minimum: 0 },
          is_active:        { type: 'boolean' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', properties: planProps },
          },
        },
        404: errorSchema,
      },
    },
  }, async (req, res) => {
    const { id } = req.params as { id: string }
    const body = updatePlanSchema.parse(req.body)

    const plan = await prisma.plan.findUnique({ where: { id } })
    if (!plan) {
      return res.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Plan no encontrado' },
      })
    }

    const updated = await prisma.plan.update({
      where: { id },
      data: body,
      include: { features: true },
    })

    return res.send({
      success: true,
      data: { ...updated, price_mxn: Number(updated.price_mxn) },
    })
  })

  // DELETE /admin/plans/:id — desactivar plan (soft delete)
  app.delete('/:id', {
    schema: {
      tags: ['Admin — Planes'],
      summary: 'Desactivar plan',
      description: 'Marca el plan como inactivo. Los tenants ya suscritos no se ven afectados.',
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
            data: { type: 'object', properties: { message: { type: 'string' } } },
          },
        },
        404: errorSchema,
      },
    },
  }, async (req, res) => {
    const { id } = req.params as { id: string }

    const plan = await prisma.plan.findUnique({ where: { id } })
    if (!plan) {
      return res.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Plan no encontrado' },
      })
    }

    await prisma.plan.update({ where: { id }, data: { is_active: false } })

    return res.send({
      success: true,
      data: { message: `Plan "${plan.name}" desactivado` },
    })
  })

  // POST /admin/plans/:id/features — agregar feature a un plan
  app.post('/:id/features', {
    schema: {
      tags: ['Admin — Planes'],
      summary: 'Agregar feature a un plan',
      description: 'Agrega una feature al plan e invalida el caché de features de los tenants suscritos.',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      body: {
        type: 'object',
        required: ['feature_key'],
        properties: {
          feature_key: {
            type: 'string',
            description: 'Clave de la feature (ej: customers, suppliers, advanced_reports, card_payments)',
          },
          limit_value: {
            type: 'string',
            default: 'true',
            description: 'Valor del límite. "true"/"false" para flags booleanos, o un número como string para límites numéricos.',
          },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                id:          { type: 'string' },
                plan_id:     { type: 'string' },
                feature_key: { type: 'string' },
                limit_value: { type: 'string' },
              },
            },
          },
        },
        404: errorSchema,
        409: errorSchema,
      },
    },
  }, async (req, res) => {
    const { id } = req.params as { id: string }
    const body = featureBodySchema.parse(req.body)

    const plan = await prisma.plan.findUnique({ where: { id } })
    if (!plan) {
      return res.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Plan no encontrado' },
      })
    }

    const existing = await prisma.planFeature.findUnique({
      where: { plan_id_feature_key: { plan_id: id, feature_key: body.feature_key } },
    })
    if (existing) {
      return res.code(409).send({
        success: false,
        error: { code: 'CONFLICT', message: 'La feature ya está asignada a este plan' },
      })
    }

    const feature = await prisma.planFeature.create({
      data: { plan_id: id, ...body },
    })

    await invalidatePlanCache(id)

    return res.code(201).send({ success: true, data: feature })
  })

  // PUT /admin/plans/:id/features/:featureKey — actualizar valor de una feature
  app.put('/:id/features/:featureKey', {
    schema: {
      tags: ['Admin — Planes'],
      summary: 'Actualizar limit_value de una feature',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id', 'featureKey'],
        properties: {
          id:         { type: 'string', format: 'uuid' },
          featureKey: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        required: ['limit_value'],
        properties: {
          limit_value: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', additionalProperties: true },
          },
        },
        404: errorSchema,
      },
    },
  }, async (req, res) => {
    const { id, featureKey } = req.params as { id: string; featureKey: string }
    const { limit_value } = z.object({ limit_value: z.string() }).parse(req.body)

    const feature = await prisma.planFeature.findUnique({
      where: { plan_id_feature_key: { plan_id: id, feature_key: featureKey } },
    })
    if (!feature) {
      return res.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Feature no encontrada en este plan' },
      })
    }

    const updated = await prisma.planFeature.update({
      where: { plan_id_feature_key: { plan_id: id, feature_key: featureKey } },
      data: { limit_value },
    })

    await invalidatePlanCache(id)

    return res.send({ success: true, data: updated })
  })

  // DELETE /admin/plans/:id/features/:featureKey — quitar feature de un plan
  app.delete('/:id/features/:featureKey', {
    schema: {
      tags: ['Admin — Planes'],
      summary: 'Quitar feature de un plan',
      description: 'Elimina la feature del plan e invalida el caché de features de los tenants suscritos.',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id', 'featureKey'],
        properties: {
          id:         { type: 'string', format: 'uuid' },
          featureKey: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', properties: { message: { type: 'string' } } },
          },
        },
        404: errorSchema,
      },
    },
  }, async (req, res) => {
    const { id, featureKey } = req.params as { id: string; featureKey: string }

    const feature = await prisma.planFeature.findUnique({
      where: { plan_id_feature_key: { plan_id: id, feature_key: featureKey } },
    })
    if (!feature) {
      return res.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Feature no encontrada en este plan' },
      })
    }

    await prisma.planFeature.delete({
      where: { plan_id_feature_key: { plan_id: id, feature_key: featureKey } },
    })

    await invalidatePlanCache(id)

    return res.send({
      success: true,
      data: { message: `Feature "${featureKey}" eliminada del plan "${id}"` },
    })
  })
}

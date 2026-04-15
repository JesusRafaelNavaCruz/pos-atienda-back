// src/modules/users/users.routes.ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import prisma, { tenantStorage } from '../../lib/prisma.js'
import { requirePermission } from '../../middleware/authorize.js'
import { env } from '../../config/env.js'
import type { JwtPayload } from '../../types/index.js'

const createUserSchema = z.object({
  email:     z.string().email(),
  password:  z.string().min(8),
  full_name: z.string().min(2).max(200),
  role_id:   z.string().uuid(),
  branch_id: z.string().uuid().optional(),
})

const updateUserSchema = z.object({
  full_name: z.string().min(2).max(200).optional(),
  role_id:   z.string().uuid().optional(),
  branch_id: z.string().uuid().optional().nullable(),
  is_active: z.boolean().optional(),
})

const changePinSchema = z.object({
  pin: z.string().length(4).regex(/^\d{4}$/).nullable(),
})

const changePasswordSchema = z.object({
  current_password: z.string(),
  new_password:     z.string().min(8),
})

// ─── Shared schema fragments ───────────────────────────────────────────────────
const userProperties = {
  id: { type: 'string' },
  email: { type: 'string' },
  full_name: { type: 'string' },
  is_active: { type: 'boolean' },
  last_login_at: { type: 'string', format: 'date-time', nullable: true },
  created_at: { type: 'string', format: 'date-time' },
  role: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      code: { type: 'string' },
      permissions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            permission: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                resource: { type: 'string' },
                action: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
  branch: {
    type: 'object',
    nullable: true,
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
    },
  },
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

export async function usersRoutes(app: FastifyInstance) {
  const authHook = async (req: any, rep: any) => {
    try { await req.jwtVerify() } catch { return rep.code(401).send() }
  }

  // GET /users
  app.get('/', {
    schema: {
      tags: ['Users'],
      summary: 'Listar usuarios',
      description: `Retorna los usuarios del tenant.
Los managers solo ven cajeros de su propia sucursal.`,
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          search: {
            type: 'string',
            description: 'Buscar por nombre completo o email',
          },
        },
      },
      response: {
        200: {
          description: 'Lista de usuarios',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'array',
              items: { type: 'object', properties: userProperties },
            },
          },
        },
      },
    },
    preHandler: [authHook, requirePermission('users', 'read')],
  }, async (req, res) => {
    const user = req.user as JwtPayload
    const { search } = z.object({ search: z.string().optional() }).parse(req.query)

    const where: any = { tenant_id: user.tenantId }
    if (search) {
      where.OR = [
        { full_name: { contains: search, mode: 'insensitive' } },
        { email:     { contains: search, mode: 'insensitive' } },
      ]
    }

    // Managers solo pueden ver cajeros de su sucursal
    if (user.roleCode === 'manager' && user.branchId) {
      where.branch_id = user.branchId
      where.role = { code: 'cashier' }
    }

    const users = await tenantStorage.run(user.tenantId, () =>
      prisma.user.findMany({
        where,
        select: {
          id: true, email: true, full_name: true, is_active: true,
          last_login_at: true, created_at: true,
          role:   { select: { id: true, name: true, code: true } },
          branch: { select: { id: true, name: true } },
        },
        orderBy: { full_name: 'asc' },
      }),
    )

    return res.send({ success: true, data: users })
  })

  // GET /users/roles — listar roles del tenant
  app.get('/roles', {
    schema: {
      tags: ['Users'],
      summary: 'Listar roles',
      description: 'Retorna todos los roles del tenant con sus permisos y conteo de usuarios asignados.',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          description: 'Lista de roles',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  code: { type: 'string' },
                  permissions: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        role_id: { type: 'string' },
                        permission_id: { type: 'string' },
                        permission: {
                          type: 'object',
                          properties: {
                            id: { type: 'string' },
                            resource: { type: 'string' },
                            action: { type: 'string' },
                          },
                        },
                      },
                    },
                  },
                  _count: {
                    type: 'object',
                    properties: {
                      users: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    preHandler: [authHook, requirePermission('users', 'read')],
  }, async (req, res) => {
    const user = req.user as JwtPayload

    const roles = await tenantStorage.run(user.tenantId, () =>
      prisma.role.findMany({
        where: { tenant_id: user.tenantId },
        include: {
          permissions: { include: { permission: true } },
          _count: { select: { users: true } },
        },
        orderBy: { name: 'asc' },
      }),
    )

    return res.send({ success: true, data: roles })
  })

  // GET /users/me/password — esta ruta debe declararse ANTES de /:id
  app.put('/me/password', {
    schema: {
      tags: ['Users'],
      summary: 'Cambiar mi contraseña',
      description: 'Permite al usuario autenticado cambiar su propia contraseña. Invalida todas las sesiones activas al completar.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['current_password', 'new_password'],
        properties: {
          current_password: { type: 'string', description: 'Contraseña actual' },
          new_password: { type: 'string', minLength: 8, description: 'Nueva contraseña' },
        },
      },
      response: {
        200: {
          description: 'Contraseña actualizada. Las sesiones activas fueron invalidadas.',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: { message: { type: 'string' } },
            },
          },
        },
        400: { description: 'Contraseña actual incorrecta', ...errorResponse },
        404: { description: 'Usuario no encontrado', ...errorResponse },
      },
    },
    preHandler: [authHook],
  }, async (req, res) => {
    const user = req.user as JwtPayload
    const { current_password, new_password } = changePasswordSchema.parse(req.body)

    const found = await tenantStorage.run(user.tenantId, () =>
      prisma.user.findUnique({ where: { id: user.sub } }),
    )
    if (!found) return res.code(404).send()

    const valid = await bcrypt.compare(current_password, found.password_hash)
    if (!valid) {
      return res.code(400).send({
        success: false,
        error: { code: 'INVALID_PASSWORD', message: 'La contraseña actual es incorrecta' },
      })
    }

    const password_hash = await bcrypt.hash(new_password, env.BCRYPT_ROUNDS)
    await tenantStorage.run(user.tenantId, () =>
      prisma.user.update({ where: { id: user.sub }, data: { password_hash } }),
    )

    // Invalidar todas las sesiones activas
    await tenantStorage.run(user.tenantId, () =>
      prisma.userSession.deleteMany({ where: { user_id: user.sub } }),
    )

    return res.send({
      success: true,
      data: { message: 'Contraseña actualizada. Por favor, inicia sesión nuevamente.' },
    })
  })

  // GET /users/:id
  app.get('/:id', {
    schema: {
      tags: ['Users'],
      summary: 'Obtener usuario por ID',
      description: 'Retorna el detalle del usuario con su rol, permisos y sucursal asignada.',
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
          description: 'Detalle del usuario',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', properties: userProperties },
          },
        },
        404: { description: 'Usuario no encontrado', ...errorResponse },
      },
    },
    preHandler: [authHook, requirePermission('users', 'read')],
  }, async (req, res) => {
    const user = req.user as JwtPayload
    const { id } = req.params as { id: string }

    const found = await tenantStorage.run(user.tenantId, () =>
      prisma.user.findFirst({
        where: { id, tenant_id: user.tenantId },
        select: {
          id: true, email: true, full_name: true, is_active: true,
          last_login_at: true, created_at: true, updated_at: true,
          role:   { include: { permissions: { include: { permission: true } } } },
          branch: true,
        },
      }),
    )

    if (!found) {
      return res.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Usuario no encontrado' },
      })
    }

    return res.send({ success: true, data: found })
  })

  // POST /users — crear usuario en el tenant
  app.post('/', {
    schema: {
      tags: ['Users'],
      summary: 'Crear usuario',
      description: `Crea un nuevo usuario en el tenant.
Valida el límite de usuarios según el plan activo.
Los managers solo pueden crear usuarios con rol de cajero.`,
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['email', 'password', 'full_name', 'role_id'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 8 },
          full_name: { type: 'string', minLength: 2, maxLength: 200 },
          role_id: { type: 'string', format: 'uuid' },
          branch_id: { type: 'string', format: 'uuid' },
        },
      },
      response: {
        201: {
          description: 'Usuario creado exitosamente',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', properties: userProperties },
          },
        },
        400: { description: 'Rol inválido', ...errorResponse },
        403: { description: 'Límite de usuarios alcanzado o sin permiso', ...errorResponse },
        409: { description: 'Email ya registrado en este tenant', ...errorResponse },
      },
    },
    preHandler: [authHook, requirePermission('users', 'create')],
  }, async (req, res) => {
    const user = req.user as JwtPayload
    const body = createUserSchema.parse(req.body)

    // Verificar límite de usuarios según el plan
    const [sub, userCount] = await Promise.all([
      prisma.subscription.findFirst({
        where: { tenant_id: user.tenantId, status: { in: ['active', 'trialing'] } },
        include: { plan: true },
      }),
      tenantStorage.run(user.tenantId, () =>
        prisma.user.count({ where: { tenant_id: user.tenantId, is_active: true } }),
      ),
    ])

    if (sub && userCount >= sub.plan.max_users) {
      return res.code(403).send({
        success: false,
        error: {
          code: 'LIMIT_REACHED',
          message: `Tu plan permite un máximo de ${sub.plan.max_users} usuarios. Actualiza tu plan para agregar más.`,
        },
      })
    }

    // Verificar email único en el tenant
    const existing = await tenantStorage.run(user.tenantId, () =>
      prisma.user.findFirst({ where: { tenant_id: user.tenantId, email: body.email } }),
    )
    if (existing) {
      return res.code(409).send({
        success: false,
        error: { code: 'CONFLICT', message: 'Ya existe un usuario con ese email en este tenant' },
      })
    }

    // Verificar que el role pertenece al tenant
    const role = await tenantStorage.run(user.tenantId, () =>
      prisma.role.findFirst({ where: { id: body.role_id, tenant_id: user.tenantId } }),
    )
    if (!role) {
      return res.code(400).send({
        success: false,
        error: { code: 'BAD_req', message: 'Rol inválido' },
      })
    }

    // Managers solo pueden crear cajeros
    if (user.roleCode === 'manager' && role.code !== 'cashier') {
      return res.code(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Solo puedes crear usuarios con rol de cajero' },
      })
    }

    const password_hash = await bcrypt.hash(body.password, env.BCRYPT_ROUNDS)

    const newUser = await tenantStorage.run(user.tenantId, () =>
      prisma.user.create({
        data: {
          tenant_id: user.tenantId,
          email:     body.email,
          full_name: body.full_name,
          role_id:   body.role_id,
          branch_id: body.branch_id ?? null,
          password_hash,
        },
        select: {
          id: true, email: true, full_name: true, is_active: true, created_at: true,
          role:   { select: { name: true, code: true } },
          branch: { select: { name: true } },
        },
      }),
    )

    return res.code(201).send({ success: true, data: newUser })
  })

  // PUT /users/:id
  app.put('/:id', {
    schema: {
      tags: ['Users'],
      summary: 'Actualizar usuario',
      description: 'Actualiza el nombre, rol, sucursal o estado activo de un usuario. No se puede modificar al usuario owner a menos que seas owner.',
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
          full_name: { type: 'string', minLength: 2, maxLength: 200 },
          role_id: { type: 'string', format: 'uuid' },
          branch_id: { type: 'string', format: 'uuid', nullable: true },
          is_active: { type: 'boolean' },
        },
      },
      response: {
        200: {
          description: 'Usuario actualizado',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', properties: userProperties },
          },
        },
        403: { description: 'Sin permiso para modificar este usuario', ...errorResponse },
        404: { description: 'Usuario no encontrado', ...errorResponse },
      },
    },
    preHandler: [authHook, requirePermission('users', 'update')],
  }, async (req, res) => {
    const user = req.user as JwtPayload
    const { id } = req.params as { id: string }
    const body = updateUserSchema.parse(req.body)

    const existing = await tenantStorage.run(user.tenantId, () =>
      prisma.user.findFirst({
        where: { id, tenant_id: user.tenantId },
        include: { role: true },
      }),
    )
    if (!existing) {
      return res.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Usuario no encontrado' },
      })
    }

    // Proteger al owner: no se puede desactivar ni cambiar su rol
    if (existing.role.code === 'owner' && user.roleCode !== 'owner') {
      return res.code(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'No puedes modificar al dueño del negocio' },
      })
    }

    const updated = await tenantStorage.run(user.tenantId, () =>
      prisma.user.update({
        where: { id },
        data:  body,
        select: {
          id: true, email: true, full_name: true, is_active: true,
          role:   { select: { name: true, code: true } },
          branch: { select: { name: true } },
        },
      }),
    )

    return res.send({ success: true, data: updated })
  })

  // DELETE /users/:id — soft delete
  app.delete('/:id', {
    schema: {
      tags: ['Users'],
      summary: 'Desactivar usuario',
      description: 'Realiza un soft delete del usuario (is_active = false). No se puede eliminar al owner ni al propio usuario.',
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
          description: 'Usuario desactivado',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: { message: { type: 'string' } },
            },
          },
        },
        400: { description: 'No puedes eliminar tu propio usuario', ...errorResponse },
        403: { description: 'No puedes eliminar al owner', ...errorResponse },
        404: { description: 'Usuario no encontrado', ...errorResponse },
      },
    },
    preHandler: [authHook, requirePermission('users', 'delete')],
  }, async (req, res) => {
    const user = req.user as JwtPayload
    const { id } = req.params as { id: string }

    if (id === user.sub) {
      return res.code(400).send({
        success: false,
        error: { code: 'BAD_req', message: 'No puedes eliminar tu propio usuario' },
      })
    }

    const existing = await tenantStorage.run(user.tenantId, () =>
      prisma.user.findFirst({
        where: { id, tenant_id: user.tenantId },
        include: { role: true },
      }),
    )
    if (!existing) {
      return res.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Usuario no encontrado' },
      })
    }

    if (existing.role.code === 'owner') {
      return res.code(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'No puedes eliminar al dueño del negocio' },
      })
    }

    await tenantStorage.run(user.tenantId, () =>
      prisma.user.update({ where: { id }, data: { is_active: false } }),
    )

    return res.send({ success: true, data: { message: 'Usuario desactivado' } })
  })

  // PUT /users/:id/pin — asignar o eliminar PIN de acceso rápido
  app.put('/:id/pin', {
    schema: {
      tags: ['Users'],
      summary: 'Asignar o eliminar PIN',
      description: 'Establece o elimina el PIN de acceso rápido de un usuario. Solo el propio usuario o el owner pueden modificarlo.',
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
        required: ['pin'],
        properties: {
          pin: {
            type: 'string',
            minLength: 4,
            maxLength: 4,
            nullable: true,
            description: 'PIN numérico de 4 dígitos. Enviar null para eliminar el PIN.',
          },
        },
      },
      response: {
        200: {
          description: 'PIN actualizado o eliminado',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: { message: { type: 'string' } },
            },
          },
        },
        403: { description: 'Sin permiso para cambiar el PIN de este usuario', ...errorResponse },
      },
    },
    preHandler: [authHook],
  }, async (req, res) => {
    const user = req.user as JwtPayload
    const { id } = req.params as { id: string }
    const { pin } = changePinSchema.parse(req.body)

    // Solo el propio usuario o el owner pueden cambiar el PIN
    if (id !== user.sub && user.roleCode !== 'owner') {
      return res.code(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Solo puedes cambiar tu propio PIN' },
      })
    }

    const pin_hash = pin ? await bcrypt.hash(pin, 10) : null

    await tenantStorage.run(user.tenantId, () =>
      prisma.user.update({ where: { id }, data: { pin_hash } }),
    )

    return res.send({
      success: true,
      data: { message: pin ? 'PIN actualizado' : 'PIN eliminado' },
    })
  })
}

import prisma, { tenantStorage } from "@/lib/prisma";
import { requireFeature, requirePermission } from "@/middleware/authorize";
import { JwtPayload } from "@/types";
import { FastifyInstance } from "fastify";
import z, { custom, success } from "zod";

// Schemas
const customerSchema = z.object({
  name: z.string().min(1).max(150),
  phone: z.string().max(30).optional(),
  email: z.string().email().optional(),
  rfc: z.string().max(13).optional(),
  address: z.string().optional(),
  credit_limit: z.coerce.number().min(0).default(0),
  notes: z.string().optional(),
});

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  search: z.string().optional(),
  sortBy: z.enum(["name", "created_at", "loyalty_points"]).default("name"),
  sortOrder: z.enum(["asc", "desc"]).default("asc"),
});

// ─── Shared schema fragments ───────────────────────────────────────────────────
const customerProperties = {
  id: { type: "string" },
  name: { type: "string" },
  phone: { type: "string", nullable: true },
  email: { type: "string", nullable: true },
  rfc: { type: "string", nullable: true },
  address: { type: "string", nullable: true },
  credit_limit: { type: "number" },
  loyalty_points: { type: "integer" },
  is_active: { type: "boolean" },
  notes: { type: "string", nullable: true },
  created_at: { type: "string", format: "date-time" },
};

const errorResponse = {
  type: "object",
  properties: {
    success: { type: "boolean" },
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
      },
    },
  },
};

export async function customerRoutes(app: FastifyInstance) {
  const authHook = async (req: any, res: any) => {
    try {
      await req.jwtVerify();
    } catch {
      return res.code(401).send();
    }
  };

  const featureHook = requireFeature("customers");

  // GET /customers
  app.get(
    "/",
    {
      schema: {
        tags: ["Customers"],
        summary: "Listar clientes",
        description:
          "Retorna la lista paginada de clientes activos del tenant. Requiere el feature `customers` en el plan.",
        security: [{ bearerAuth: [] }],
        querystring: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            search: {
              type: "string",
              description: "Buscar por nombre, teléfono, RFC o email",
            },
            sortBy: {
              type: "string",
              enum: ["name", "created_at", "loyalty_points"],
              default: "name",
            },
            sortOrder: { type: "string", enum: ["asc", "desc"], default: "asc" },
          },
        },
        response: {
          200: {
            description: "Lista de clientes",
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "array",
                items: { type: "object", properties: customerProperties },
              },
              meta: {
                type: "object",
                properties: {
                  page: { type: "integer" },
                  limit: { type: "integer" },
                  total: { type: "integer" },
                  totalPages: { type: "integer" },
                },
              },
            },
          },
        },
      },
      preHandler: [
        authHook,
        featureHook,
        requirePermission("customers", "read"),
      ],
    },
    async (req, res) => {
      const user = req.user as JwtPayload;

      const { page, limit, search, sortBy, sortOrder } = querySchema.parse(
        req.query,
      );

      const where: any = { tenant_id: user.tenantId, is_active: true };
      if (search) {
        where.OR = [
          { name: { contains: search, mode: "insensitive" } },
          { phone: { contains: search } },
          { rfc: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
        ];
      }

      const [customers, total] = await tenantStorage.run(user.tenantId, () =>
        Promise.all([
          prisma.customer.findMany({
            where,
            include: {
              _count: {
                select: {
                  sales: true,
                },
              },
            },
            orderBy: {
              [sortBy]: sortOrder,
            },
            skip: (page - 1) * limit,
            take: limit,
          }),
          prisma.customer.count({ where }),
        ]),
      );

      return res.send({
        success: true,
        data: customers,
        meta: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    },
  );

  // GET /customers/:id - con historial de compras
  app.get(
    "/:id",
    {
      schema: {
        tags: ["Customers"],
        summary: "Obtener cliente por ID",
        description:
          "Retorna el detalle del cliente incluyendo sus últimas 10 compras completadas y estadísticas de gasto total.",
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", format: "uuid" },
          },
        },
        response: {
          200: {
            description: "Detalle del cliente con historial",
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  ...customerProperties,
                  sales: { type: "array", items: { type: "object" } },
                  stats: {
                    type: "object",
                    properties: {
                      totalPurchases: { type: "integer" },
                      totalSpent: { type: "number" },
                    },
                  },
                },
              },
            },
          },
          404: { description: "Cliente no encontrado", ...errorResponse },
        },
      },
      preHandler: [
        authHook,
        featureHook,
        requirePermission("customers", "read"),
      ],
    },
    async (req, res) => {
      const user = req.user as JwtPayload;
      const { id } = req.params as { id: string };

      const customer = await tenantStorage.run(user.tenantId, () =>
        prisma.customer.findFirst({
          where: { id, tenant_id: user.tenantId },
          include: {
            sales: {
              where: { status: "completed" },
              orderBy: { created_at: "asc" },
              take: 10,
              select: {
                id: true,
                folio: true,
                total: true,
                created_at: true,
                status: true,
              },
            },
          },
        }),
      );

      if (!customer) {
        return res.code(404).send({
          success: false,
          error: {
            code: "NOT_FOUND",
            message: "Cliente no encontrado",
          },
        });
      }

      const stats = await tenantStorage.run(user.tenantId, () =>
        prisma.sale.aggregate({
          where: {
            customer_id: id,
            tenant_id: user.tenantId,
            status: "completed",
          },
          _count: { id: true },
          _sum: { total: true },
        }),
      );

      return res.send({
        success: true,
        data: {
          ...customer,
          stats: {
            totalPurchases: stats._count.id,
            totalSpent: Number(stats._sum.total ?? 0),
          },
        },
      });
    },
  );

  // POST /customers
  app.post(
    "/",
    {
      schema: {
        tags: ["Customers"],
        summary: "Crear cliente",
        description: "Registra un nuevo cliente en el tenant.",
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 150 },
            phone: { type: "string", maxLength: 30 },
            email: { type: "string", format: "email" },
            rfc: { type: "string", maxLength: 13 },
            address: { type: "string" },
            credit_limit: { type: "number", minimum: 0, default: 0 },
            notes: { type: "string" },
          },
        },
        response: {
          201: {
            description: "Cliente creado exitosamente",
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: { type: "object", properties: customerProperties },
            },
          },
        },
      },
      preHandler: [
        authHook,
        featureHook,
        requirePermission("customers", "create"),
      ],
    },
    async (req, res) => {
      const user = req.user as JwtPayload;
      const body = customerSchema.parse(req.body);

      const customer = await tenantStorage.run(user.tenantId, () =>
        prisma.customer.create({ data: { ...body, tenant_id: user.tenantId } }),
      );

      return res.code(201).send({ success: true, data: customer });
    },
  );

  // PUT /customers/:id
  app.put(
    "/:id",
    {
      schema: {
        tags: ["Customers"],
        summary: "Actualizar cliente",
        description: "Actualiza parcialmente los datos de un cliente.",
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", format: "uuid" },
          },
        },
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 150 },
            phone: { type: "string", maxLength: 30 },
            email: { type: "string", format: "email" },
            rfc: { type: "string", maxLength: 13 },
            address: { type: "string" },
            credit_limit: { type: "number", minimum: 0 },
            notes: { type: "string" },
          },
        },
        response: {
          200: {
            description: "Cliente actualizado",
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: { type: "object", properties: customerProperties },
            },
          },
          404: { description: "Cliente no encontrado", ...errorResponse },
        },
      },
      preHandler: [
        authHook,
        featureHook,
        requirePermission("customers", "update"),
      ],
    },
    async (req, res) => {
      const user = req.user as JwtPayload;
      const { id } = req.params as { id: string };
      const body = customerSchema.partial().parse(req.body);

      const existing = await tenantStorage.run(user.tenantId, () =>
        prisma.customer.findFirst({ where: { id, tenant_id: user.tenantId } }),
      );

      if (!existing) {
        return res.code(404).send({
          success: false,
          error: { code: "NOT_FOUND", message: "Cliente no encontrado" },
        });
      }

      const customer = await tenantStorage.run(user.tenantId, () =>
        prisma.customer.update({ where: { id }, data: body }),
      );

      return res.send({
        success: true,
        data: customer,
      });
    },
  );

  // DELETE /customers/:id
  app.delete(
    "/:id",
    {
      schema: {
        tags: ["Customers"],
        summary: "Desactivar cliente",
        description:
          "Realiza un soft delete del cliente (is_active = false).",
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", format: "uuid" },
          },
        },
        response: {
          200: {
            description: "Cliente desactivado",
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "object",
                properties: { message: { type: "string" } },
              },
            },
          },
          404: { description: "Cliente no encontrado", ...errorResponse },
        },
      },
      preHandler: [
        authHook,
        featureHook,
        requirePermission("customers", "create"),
      ],
    },
    async (req, res) => {

        const user = req.user as JwtPayload;
        const { id } = req.params as { id: string };

        const existing = await tenantStorage.run(user.tenantId, () =>
            prisma.customer.findFirst({ where: { id, tenant_id: user.tenantId } })
        )

        if (!existing) {
            return res.code(404).send({
                success: false,
                error: {
                    code: "NOT_FOUND",
                    message: "Cliente no encontrado"
                }
            })
        }

        await tenantStorage.run(user.tenantId, () =>
            prisma.customer.update({ where: { id }, data: { is_active: false } })
        )

        return res.send({
            success: true,
            data: {
                message: "Cliente desactivado"
            }
        })
    }
  );

  // POST /customers/:id/redeem
  app.post('/:id/redeem', {
    schema: {
      tags: ["Customers"],
      summary: "Canjear puntos de lealtad",
      description:
        "Descuenta puntos de lealtad del cliente. Cada punto equivale a $1 MXN de descuento.",
      security: [{ bearerAuth: [] }],
      params: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", format: "uuid" },
        },
      },
      body: {
        type: "object",
        required: ["points"],
        properties: {
          points: {
            type: "integer",
            minimum: 1,
            description: "Cantidad de puntos a canjear",
          },
        },
      },
      response: {
        200: {
          description: "Puntos canjeados exitosamente",
          type: "object",
          properties: {
            success: { type: "boolean" },
            data: {
              type: "object",
              properties: {
                pointsRedeemed: { type: "integer" },
                remainingPoints: { type: "integer" },
                discountValue: { type: "number" },
              },
            },
          },
        },
        400: { description: "Puntos insuficientes", ...errorResponse },
        404: { description: "Cliente no encontrado", ...errorResponse },
      },
    },
    preHandler: [authHook, featureHook, requirePermission('customers', 'update')]
  }, async (req, res) => {

    const user = req.user as JwtPayload;
    const { id } = req.params as { id: string };
    const { points } = z.object({
        points: z.number().int().positive()
    }).parse(req.body);

    const customer = await tenantStorage.run(user.tenantId, () =>
        prisma.customer.findFirst({ where: { id, tenant_id: user.tenantId } })
    )

    if (!customer) {
        return res.code(404).send({
            success: false,
            error: {
                code: 'NOT_FOUND',
                message: 'Cliente no encontrado'
            }
        })
    }

    if (customer.loyalty_points < points) {
        return res.code(400).send({
            success: false,
            error: {
                code: "INSUFFICIENT_POINTS",
                message: `El cliente solo tiene ${customer.loyalty_points} puntos disponibles`
            }
        })
    }

    const updated = await tenantStorage.run(user.tenantId, () =>
        prisma.customer.update({
            where: { id },
            data: {
                loyalty_points: {
                    decrement: points
                }
            }
        })
    )

    return res.send({
        success: true,
        data: {
            pointsRedeemed: points,
            remainingPoints: updated.loyalty_points,
            discountValue: points
        }
    });

  })

}

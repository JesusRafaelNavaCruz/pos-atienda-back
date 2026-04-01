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
      preHandler: [
        authHook,
        featureHook,
        requirePermission("customer", "read"),
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
        return res.code(401).send({
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
      preHandler: [
        authHook,
        featureHook,
        requirePermission("customer", "create"),
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

  // PUT /customer/:id
  app.put(
    "/:id",
    {
      preHandler: [
        authHook,
        featureHook,
        requirePermission("customer", "update"),
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
        return res.code(401).send({
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

  // DELETE /customer/:id
  app.delete(
    "/",
    {
      preHandler: [
        authHook,
        featureHook,
        requirePermission("customer", "create"),
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
        return res.code(401).send({
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

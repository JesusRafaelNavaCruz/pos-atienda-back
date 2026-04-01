import prisma, { tenantStorage } from "@/lib/prisma";
import { requireFeature, requirePermission } from "@/middleware/authorize";
import { JwtPayload } from "@/types";
import { FastifyInstance } from "fastify";
import z from "zod";

const adjustSchema = z.object({
  product_id: z.string().uuid(),
  delta: z.number().min(1),
  type: z.enum(["purchase", "adjustment", "loss"]),
  reason: z.string().min(3),
  branch_id: z.string().uuid().optional(),
});

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  product_id: z.string().uuid().optional(),
  type: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export async function inventoryRoutes(app: FastifyInstance) {
  const authHook = async (req: any, res: any) => {
    try {
      await req.jwtVerify();
    } catch {
      return res.code(401).send();
    }
  };

  // GET /inventory/movements
  app.get(
    "/movements",
    {
      preHandler: [authHook, requirePermission("inventory", "read")],
    },
    async (req, res) => {
      const user = req.user as JwtPayload;
      const { page, limit, product_id, type, from, to } = querySchema.parse(
        req.query,
      );

      const where: any = { tenant_id: user.tenantId };
      if (product_id) where.product_id = product_id;
      if (type) where.type = type;
      if (from || to) {
        where.created_at = {};
        if (from) where.created_at.gte = new Date(from);
        if (to) where.created_at.lte = new Date(to);
      }

      const [movements, total] = await tenantStorage.run(user.tenantId, () =>
        Promise.all([
          prisma.inventoryMovement.findMany({
            where,
            include: {
              product: { select: { name: true, barcode: true, unit: true } },
              user: { select: { full_name: true } },
            },
            orderBy: { created_at: "desc" },
            skip: (page - 1) * limit,
            take: limit,
          }),
          prisma.inventoryMovement.count({ where }),
        ]),
      );

      return res.send({
        success: true,
        data: movements,
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    },
  );

  // POST /inventory/adjust
  app.post(
    "/adjust",
    {
      preHandler: [authHook, requirePermission("inventory", "adjust")],
    },
    async (req, res) => {
      const user = req.user as JwtPayload;
      const body = adjustSchema.parse(req.body);

      const movement = await tenantStorage.run(user.tenantId, () =>
        prisma.$transaction(async (tx) => {
          const product = await tx.product.findFirst({
            where: { id: body.product_id, tenant_id: user.tenantId },
          });

          if (!product) throw new Error("Producto no encontrado");

          const before = Number(product.stock);
          const after = before + body.delta;

          if (after < 0)
            throw new Error("El ajuste resultaría en stock negativo");

          await tx.product.update({
            where: { id: body.product_id },
            data: { stock: after },
          });

          return tx.inventoryMovement.create({
            data: {
              tenant_id: user.tenantId,
              product_id: body.product_id,
              user_id: user.sub,
              branch_id: body.branch_id ?? user.branchId,
              type: body.type,
              quantity_before: before,
              quantity_after: after,
              delta: body.delta,
              reason: body.reason,
            },
            include: { product: { select: { name: true, unit: true } } },
          });
        }),
      );
      return res.code(201).send({
        success: true,
        data: movement,
      });
    },
  );
}

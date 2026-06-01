import prisma, { tenantStorage } from "@/lib/prisma";
import { requirePermission } from "@/middleware/authorize";
import { JwtPayload } from "@/types";
import { FastifyInstance } from "fastify";
import z from "zod";

const adjustSchema = z.object({
  product_id: z.string().uuid(),
  // purchase: siempre positivo (entrada de mercancía)
  // loss: positivo — el sistema lo niega internamente (salida por merma)
  // adjustment: con signo — positivo = entrada, negativo = salida por conteo
  delta: z.number().refine((v) => v !== 0, { message: "El delta no puede ser cero" }),
  type: z.enum(["purchase", "adjustment", "loss"]),
  reason: z.string().min(3),
  branch_id: z.string().uuid().optional(),
  reference_id: z.string().uuid().optional(),
});

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  product_id: z.string().uuid().optional(),
  supplier_id: z.string().uuid().optional(),
  branch_id: z.string().uuid().optional(),
  type: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

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
      schema: {
        tags: ["Inventory"],
        summary: "Listar movimientos de inventario",
        description:
          "Retorna el historial paginado de movimientos de inventario. Permite filtrar por producto, tipo y rango de fechas.",
        security: [{ bearerAuth: [] }],
        querystring: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            product_id: { type: "string", format: "uuid" },
            supplier_id: { type: "string", format: "uuid", description: "Filtrar por proveedor del producto" },
            branch_id: { type: "string", format: "uuid", description: "Filtrar por sucursal" },
            type: {
              type: "string",
              enum: ["sale", "purchase", "adjustment", "loss", "return"],
              description: "Tipo de movimiento",
            },
            from: { type: "string", format: "date-time", description: "Fecha inicio (ISO 8601)" },
            to: { type: "string", format: "date-time", description: "Fecha fin (ISO 8601)" },
          },
        },
        response: {
          200: {
            description: "Historial de movimientos",
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    type: { type: "string" },
                    delta: { type: "number" },
                    quantity_before: { type: "number" },
                    quantity_after: { type: "number" },
                    reason: { type: "string" },
                    created_at: { type: "string", format: "date-time" },
                    product: { type: "object" },
                    user: { type: "object" },
                  },
                },
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
      preHandler: [authHook, requirePermission("inventory", "read")],
    },
    async (req, res) => {
      const user = req.user as JwtPayload;
      const { page, limit, product_id, supplier_id, branch_id, type, from, to } =
        querySchema.parse(req.query);

      const where: any = { tenant_id: user.tenantId };
      if (product_id) where.product_id = product_id;
      if (branch_id) where.branch_id = branch_id;
      if (type) where.type = type;
      // supplier_id: filtro indirecto a través del producto relacionado
      if (supplier_id) where.product = { supplier_id };
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
              product: {
                select: {
                  name: true,
                  barcode: true,
                  unit: true,
                  supplier: { select: { id: true, name: true } },
                },
              },
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
      schema: {
        tags: ["Inventory"],
        summary: "Ajustar stock de un producto",
        description: `Registra un movimiento de inventario y actualiza el stock del producto.
**Tipos de ajuste:**
- \`purchase\`: Entrada de mercancía (aumenta stock)
- \`adjustment\`: Ajuste manual (puede aumentar o disminuir)
- \`loss\`: Merma o pérdida (disminuye stock)`,
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["product_id", "delta", "type", "reason"],
          properties: {
            product_id: { type: "string", format: "uuid" },
            delta: {
              type: "number",
              description:
                "purchase: positivo (entrada). loss: positivo, el sistema resta. adjustment: con signo (+/-).",
            },
            type: {
              type: "string",
              enum: ["purchase", "adjustment", "loss"],
            },
            reason: {
              type: "string",
              minLength: 3,
              description: "Descripción del motivo del ajuste",
            },
            branch_id: { type: "string", format: "uuid" },
            reference_id: {
              type: "string",
              format: "uuid",
              description: "ID de referencia (ej: orden de compra)",
            },
          },
        },
        response: {
          201: {
            description: "Movimiento registrado",
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  type: { type: "string" },
                  delta: { type: "number" },
                  quantity_before: { type: "number" },
                  quantity_after: { type: "number" },
                  reason: { type: "string" },
                  product: { type: "object" },
                },
              },
            },
          },
          400: { description: "Stock resultante negativo", ...errorResponse },
          404: { description: "Producto no encontrado", ...errorResponse },
        },
      },
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

          // Calcular el delta neto según el tipo:
          // - purchase: siempre suma (el usuario envía positivo)
          // - loss: siempre resta (el usuario envía positivo, negamos internamente)
          // - adjustment: el usuario decide el signo (+entrada / -salida)
          let netDelta: number;
          if (body.type === "purchase") {
            if (body.delta <= 0) throw new Error("Una compra debe tener cantidad positiva");
            netDelta = body.delta;
          } else if (body.type === "loss") {
            if (body.delta <= 0) throw new Error("Una merma debe tener cantidad positiva");
            netDelta = -body.delta;
          } else {
            // adjustment: se acepta cualquier signo
            netDelta = body.delta;
          }

          const after = before + netDelta;

          if (after < 0)
            throw new Error(
              `Stock insuficiente: hay ${before} unidades, no se pueden restar ${Math.abs(netDelta)}`,
            );

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
              delta: netDelta,
              reason: body.reason,
              reference_id: body.reference_id,
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

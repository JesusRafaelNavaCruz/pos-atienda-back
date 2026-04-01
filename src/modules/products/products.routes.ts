import prisma, { tenantStorage } from "@/lib/prisma";
import { requireFeature, requirePermission } from "@/middleware/authorize";
import { JwtPayload } from "@/types";
import { FastifyInstance } from "fastify";
import z from "zod";
import { parse as csvParse } from 'csv-parse/sync'

// ─── Schemas ──────────────────────────────────────────────────────────────────
const productSchema = z.object({
  barcode: z.string().max(100).optional(),
  sku: z.string().max(100).optional(),
  name: z.string().min(1).max(300),
  description: z.string().optional(),
  unit: z
    .enum(["pza", "kg", "g", "lt", "ml", "caja", "paq", "rollo", "par"])
    .default("pza"),
  price: z.coerce.number().min(0),
  cost: z.coerce.number().min(0).default(0),
  stock: z.coerce.number().default(0),
  min_stock: z.coerce.number().default(0),
  sold_by_weight: z.boolean().default(false),
  category_id: z.string().uuid().optional(),
  supplier_id: z.string().uuid().optional(),
  image_url: z.string().url().optional(),
});

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  search: z.string().optional(),
  category_id: z.string().uuid().optional(),
  low_stock: z.coerce.boolean().optional(),
  is_active: z.coerce.boolean().default(true),
  sortBy: z.enum(["name", "price", "stock", "created_at"]).default("name"),
  sortOrder: z.enum(["asc", "desc"]).default("asc"),
});

export async function productsRoutes(app: FastifyInstance) {
  const authHook = async (req: any, rep: any) => {
    try {
      await req.jwtVerify();
    } catch {
      return rep.code(401).send();
    }
  };

  // GET /products
  app.get(
    "/",
    {
      preHandler: [authHook, requirePermission("products", "read")],
    },
    async (req, res) => {
      const user = req.user as JwtPayload;
      const query = querySchema.parse(req.query);
      const {
        page,
        limit,
        search,
        category_id,
        low_stock,
        is_active,
        sortBy,
        sortOrder,
      } = query;

      const where: any = {
        tenant_id: user.tenantId,
        is_active,
      };

      if (search) {
        where.OR = [
          { name: { contains: search, mode: "insensitive" } },
          { barcode: { containts: search } },
          { sku: { contains: search, mode: "insensitive" } },
        ];
      }

      if (category_id) where.category_id = category_id;

      if (low_stock) {
        where.stock = { lte: prisma.product.fields.min_stock };
      }

      const [products, total] = await tenantStorage.run(user.tenantId, () =>
        Promise.all([
          prisma.product.findMany({
            where,
            include: {
              category: { select: { id: true, name: true, color: true } },
              supplier: { select: { id: true, name: true } },
            },
            orderBy: { [sortBy]: sortOrder },
            skip: (page - 1) * limit,
            take: limit,
          }),
          prisma.product.count({ where }),
        ]),
      );

      return res.send({
        success: true,
        data: products,
        meta: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    },
  );

  // GET /products/low-stock
  app.get(
    "/low-stock",
    {
      preHandler: [authHook, requirePermission("products", "read")],
    },
    async (req, res) => {
      const user = req.user as JwtPayload;

      const products = await tenantStorage.run(
        user.tenantId,
        () =>
          prisma.$queryRaw<any[]>`
        SELECT * FROM negocio.get_low_stock_products(${user.tenantId}::uuid)
      `,
      );

      return res.send({ success: true, data: products });
    },
  );

  // GET /products/:id
  app.get(
    "/:id",
    {
      preHandler: [authHook, requirePermission("products", "read")],
    },
    async (req, res) => {
      const user = req.user as JwtPayload;
      const { id } = req.params as { id: string };

      const product = await tenantStorage.run(user.tenantId, () =>
        prisma.product.findFirst({
          where: { id, tenant_id: user.tenantId },
          include: {
            category: true,
            supplier: { select: { id: true, name: true, phone: true } },
            inventory_movements: {
              orderBy: { created_at: "desc" },
              take: 10,
              include: { user: { select: { full_name: true } } },
            },
          },
        }),
      );

      if (!product) {
        return res.code(401).send({
          success: true,
          error: { code: "NOT_FOUND", message: "Producto no encontrado" },
        });
      }

      return res.send({ success: true, data: product });
    },
  );

  // GET /products/barcode/:barcode
  app.get(
    "/barcode/:barcode",
    {
      preHandler: [authHook],
    },
    async (req, res) => {
      const user = req.user as JwtPayload;
      const { barcode } = req.params as { barcode: string };

      const product = await tenantStorage.run(user.tenantId, () =>
        prisma.product.findFirst({
          where: { barcode, tenant_id: user.tenantId, is_active: true },
          include: {
            category: { select: { name: true } },
          },
        }),
      );

      if (!product) {
        return res.code(401).send({
          success: true,
          error: {
            code: "NOT_FOUND",
            message: "Producto no encontrado para este código",
          },
        });
      }

      return res.send({ success: true, data: product });
    },
  );

  // POST /products
  app.post('/', {
    preHandler: [authHook, requirePermission('products', 'create')]
  }, async (req, res) => {
    
    const user = req.user as JwtPayload;
    const body = productSchema.parse(req.body)

    if (body.barcode) {
      const exist = await tenantStorage.run(user.tenantId, () => 
        prisma.product.findFirst({
          where: { barcode: body.barcode, tenant_id: user.tenantId }
        })      
      )
      if (exist) {
        return res.code(409).send({
          success: false,
          error: { code: 'CONFICT', message: 'Ya existe un producto con ese código de barras' }
        })
      }
    }

    const product = await tenantStorage.run(user.tenantId, () => 
      prisma.product.create({
        data: { ...body, tenant_id: user.tenantId}
      })
    )

    return res.code(201).send({ success: true, data: product })
  })

  // PUT /products/:id
  app.put('/:id', {
    preHandler: [authHook, requirePermission('products', 'read')]
  }, async (req, res) => {

    const user = req.user as JwtPayload;
    const { id } = req.params as { id: string };
    const body = productSchema.partial().parse(req.body)

    const existing = await tenantStorage.run(user.tenantId, () =>
      prisma.product.findFirst({ where: { id, tenant_id: user.tenantId } }),
    )

    if (!existing) {
      return res.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Producto no encontrado' },
      })
    }

    const product = await tenantStorage.run(user.tenantId, () =>
      prisma.product.update({ where: { id }, data: body }),
    )

    return res.send({ success: true, data: product })    
  })

  // DELETE /products/:id
  app.delete('/:id', {
    preHandler: [authHook, requirePermission('products', 'delete')],
  }, async (req, res) => {
    const user = req.user as JwtPayload
    const { id } = req.params as { id: string }

    const existing = await tenantStorage.run(user.tenantId, () =>
      prisma.product.findFirst({ where: { id, tenant_id: user.tenantId } }),
    )

    if (!existing) {
      return res.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Producto no encontrado' },
      })
    }

    await tenantStorage.run(user.tenantId, () =>
      prisma.product.update({ where: { id }, data: { is_active: false } }),
    )

    return res.send({ success: true, data: { message: 'Producto desactivado' } })
  }) 

  // POST /products/import/csv
    app.post('/import/csv', {
    preHandler: [
      authHook,
      requirePermission('inventory', 'import'),
      requireFeature('csv_import'),
    ],
  }, async (request, reply) => {
    const user = request.user as JwtPayload
    const data = await request.file()

    if (!data) {
      return reply.code(400).send({
        success: false,
        error: { code: 'BAD_REQUEST', message: 'No se recibió ningún archivo' },
      })
    }

    const buffer = await data.toBuffer()
    let records: any[]

    try {
      records = csvParse(buffer, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      })
    } catch {
      return reply.code(400).send({
        success: false,
        error: { code: 'INVALID_CSV', message: 'El archivo CSV no tiene un formato válido' },
      })
    }

    // Columnas requeridas
    const required = ['name', 'price']
    const headers = Object.keys(records[0] ?? {})
    const missing = required.filter((col) => !headers.includes(col))

    if (missing.length > 0) {
      return reply.code(400).send({
        success: false,
        error: {
          code: 'INVALID_CSV',
          message: `Columnas requeridas faltantes: ${missing.join(', ')}`,
        },
      })
    }

    const results = { created: 0, updated: 0, errors: [] as string[] }

    for (let i = 0; i < records.length; i++) {
      const row = records[i]
      try {
        const parsed = productSchema.parse({
          name:         row.name,
          barcode:      row.barcode || undefined,
          sku:          row.sku || undefined,
          price:        Number(row.price),
          cost:         Number(row.cost ?? 0),
          stock:        Number(row.stock ?? 0),
          min_stock:    Number(row.min_stock ?? 0),
          unit:         row.unit || 'pza',
          description:  row.description || undefined,
          sold_by_weight: row.sold_by_weight === 'true' || row.sold_by_weight === '1',
        })

        if (parsed.barcode) {
          const existing = await tenantStorage.run(user.tenantId, () =>
            prisma.product.findFirst({
              where: { barcode: parsed.barcode, tenant_id: user.tenantId },
            }),
          )

          if (existing) {
            await tenantStorage.run(user.tenantId, () =>
              prisma.product.update({ where: { id: existing.id }, data: parsed }),
            )
            results.updated++
            continue
          }
        }

        await tenantStorage.run(user.tenantId, () =>
          prisma.product.create({ data: { ...parsed, tenant_id: user.tenantId } }),
        )
        results.created++
      } catch (err: any) {
        results.errors.push(`Fila ${i + 2}: ${err.message}`)
      }
    }

    return reply.send({
      success: true,
      data: {
        message: `Importación completada: ${results.created} creados, ${results.updated} actualizados`,
        ...results,
      },
    })
  })

}

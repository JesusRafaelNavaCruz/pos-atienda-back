import prisma, { tenantStorage } from "@/lib/prisma";
import { requireFeature, requirePermission } from "@/middleware/authorize";
import z from "zod";
import { parse as csvParse } from 'csv-parse/sync';
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
    supplier_id: z.string().uuid().optional(),
    low_stock: z.coerce.boolean().optional(),
    is_active: z.boolean().optional(),
    sortBy: z.enum(["name", "price", "stock", "created_at"]).default("name"),
    sortOrder: z.enum(["asc", "desc"]).default("asc"),
});
// ─── Shared schema fragments ───────────────────────────────────────────────────
const productProperties = {
    id: { type: "string" },
    barcode: { type: "string", nullable: true },
    sku: { type: "string", nullable: true },
    name: { type: "string" },
    description: { type: "string", nullable: true },
    unit: { type: "string" },
    price: { type: "number" },
    cost: { type: "number" },
    stock: { type: "number" },
    min_stock: { type: "number" },
    sold_by_weight: { type: "boolean" },
    is_active: { type: "boolean" },
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
export async function productsRoutes(app) {
    const authHook = async (req, rep) => {
        try {
            await req.jwtVerify();
        }
        catch {
            return rep.code(401).send();
        }
    };
    // GET /products
    app.get("/", {
        schema: {
            tags: ["Products"],
            summary: "Listar productos",
            description: "Retorna la lista paginada de productos del tenant. Permite filtrar por nombre/barcode/sku, categoría y stock bajo.",
            security: [{ bearerAuth: [] }],
            querystring: {
                type: "object",
                properties: {
                    page: { type: "integer", minimum: 1, default: 1 },
                    limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
                    search: { type: "string", description: "Buscar por nombre, barcode o SKU" },
                    category_id: { type: "string", format: "uuid" },
                    supplier_id: { type: "string", format: "uuid", description: "Filtrar por proveedor" },
                    low_stock: { type: "boolean", description: "Filtrar productos con stock bajo" },
                    is_active: { type: "boolean" },
                    sortBy: {
                        type: "string",
                        enum: ["name", "price", "stock", "created_at"],
                        default: "name",
                    },
                    sortOrder: { type: "string", enum: ["asc", "desc"], default: "asc" },
                },
            },
            response: {
                200: {
                    description: "Lista de productos",
                    type: "object",
                    properties: {
                        success: { type: "boolean" },
                        data: { type: "array", items: { type: "object", properties: productProperties } },
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
        preHandler: [authHook, requirePermission("products", "read")],
    }, async (req, res) => {
        const user = req.user;
        const query = querySchema.parse(req.query);
        const { page, limit, search, category_id, supplier_id, low_stock, is_active, sortBy, sortOrder, } = query;
        const where = {
            tenant_id: user.tenantId,
        };
        if (search) {
            where.OR = [
                { name: { contains: search, mode: "insensitive" } },
                { barcode: { contains: search } },
                { sku: { contains: search, mode: "insensitive" } },
            ];
        }
        if (is_active !== undefined)
            where.is_active = is_active;
        if (category_id)
            where.category_id = category_id;
        if (supplier_id)
            where.supplier_id = supplier_id;
        if (low_stock) {
            where.stock = { lte: prisma.product.fields.min_stock };
        }
        const [products, total] = await tenantStorage.run(user.tenantId, () => Promise.all([
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
        ]));
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
    });
    // GET /products/barcodes
    app.get("/barcodes", {
        schema: {
            tags: ["Products"],
            summary: "Listar barcodes de productos",
            description: "Retorna id, nombre, barcode y SKU de todos los productos activos. " +
                "Con `only_with_barcode=true` filtra solo los que tienen código asignado.",
            security: [{ bearerAuth: [] }],
            querystring: {
                type: "object",
                properties: {
                    only_with_barcode: {
                        type: "boolean",
                        default: false,
                        description: "Si es true, excluye productos sin barcode",
                    },
                },
            },
            response: {
                200: {
                    type: "object",
                    properties: {
                        success: { type: "boolean" },
                        data: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    id: { type: "string" },
                                    name: { type: "string" },
                                    sku: { type: "string", nullable: true },
                                    barcode: { type: "string", nullable: true },
                                    unit: { type: "string" },
                                    price: { type: "number" },
                                },
                            },
                        },
                        meta: {
                            type: "object",
                            properties: { total: { type: "integer" } },
                        },
                    },
                },
            },
        },
        preHandler: [authHook, requirePermission("products", "read")],
    }, async (req, res) => {
        const user = req.user;
        const { only_with_barcode } = z
            .object({ only_with_barcode: z.coerce.boolean().default(false) })
            .parse(req.query);
        const where = { tenant_id: user.tenantId, is_active: true };
        if (only_with_barcode)
            where.barcode = { not: null };
        const products = await tenantStorage.run(user.tenantId, () => prisma.product.findMany({
            where,
            select: { id: true, name: true, sku: true, barcode: true, unit: true, price: true },
            orderBy: { name: "asc" },
        }));
        return res.send({
            success: true,
            data: products,
            meta: { total: products.length },
        });
    });
    // GET /products/low-stock
    app.get("/low-stock", {
        schema: {
            tags: ["Products"],
            summary: "Productos con stock bajo",
            description: "Retorna todos los productos cuyo stock actual es menor o igual al stock mínimo configurado.",
            security: [{ bearerAuth: [] }],
            response: {
                200: {
                    description: "Productos con stock bajo",
                    type: "object",
                    properties: {
                        success: { type: "boolean" },
                        data: { type: "array", items: { type: "object" } },
                    },
                },
            },
        },
        preHandler: [authHook, requirePermission("products", "read")],
    }, async (req, res) => {
        const user = req.user;
        const products = await tenantStorage.run(user.tenantId, () => prisma.$queryRaw `
        SELECT * FROM negocio.get_low_stock_products(${user.tenantId}::uuid)
      `);
        return res.send({ success: true, data: products });
    });
    // GET /products/:id
    app.get("/:id", {
        schema: {
            tags: ["Products"],
            summary: "Obtener producto por ID",
            description: "Retorna el detalle completo de un producto, incluyendo categoría, proveedor y los últimos 10 movimientos de inventario.",
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
                    description: "Detalle del producto",
                    type: "object",
                    properties: {
                        success: { type: "boolean" },
                        data: { type: "object", properties: productProperties },
                    },
                },
                404: { description: "Producto no encontrado", ...errorResponse },
            },
        },
        preHandler: [authHook, requirePermission("products", "read")],
    }, async (req, res) => {
        const user = req.user;
        const { id } = req.params;
        const product = await tenantStorage.run(user.tenantId, () => prisma.product.findFirst({
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
        }));
        if (!product) {
            return res.code(404).send({
                success: false,
                error: { code: "NOT_FOUND", message: "Producto no encontrado" },
            });
        }
        return res.send({ success: true, data: product });
    });
    // GET /products/barcode/:barcode
    app.get("/barcode/:barcode", {
        schema: {
            tags: ["Products"],
            summary: "Buscar producto por código de barras",
            description: "Busca un producto activo por su código de barras. Útil para el escáner del POS.",
            security: [{ bearerAuth: [] }],
            params: {
                type: "object",
                required: ["barcode"],
                properties: {
                    barcode: { type: "string", description: "Código de barras del producto" },
                },
            },
            response: {
                200: {
                    description: "Producto encontrado",
                    type: "object",
                    properties: {
                        success: { type: "boolean" },
                        data: { type: "object", properties: productProperties },
                    },
                },
                404: { description: "Producto no encontrado", ...errorResponse },
            },
        },
        preHandler: [authHook],
    }, async (req, res) => {
        const user = req.user;
        const { barcode } = req.params;
        const product = await tenantStorage.run(user.tenantId, () => prisma.product.findFirst({
            where: { barcode, tenant_id: user.tenantId, is_active: true },
            include: {
                category: { select: { name: true } },
            },
        }));
        if (!product) {
            return res.code(404).send({
                success: false,
                error: {
                    code: "NOT_FOUND",
                    message: "Producto no encontrado para este código",
                },
            });
        }
        return res.send({ success: true, data: product });
    });
    // POST /products
    app.post('/', {
        schema: {
            tags: ["Products"],
            summary: "Crear producto",
            description: "Crea un nuevo producto en el catálogo del tenant.",
            security: [{ bearerAuth: [] }],
            body: {
                type: "object",
                required: ["name", "price"],
                properties: {
                    barcode: { type: "string", maxLength: 100 },
                    sku: { type: "string", maxLength: 100 },
                    name: { type: "string", minLength: 1, maxLength: 300 },
                    description: { type: "string" },
                    unit: {
                        type: "string",
                        enum: ["pza", "kg", "g", "lt", "ml", "caja", "paq", "rollo", "par"],
                        default: "pza",
                    },
                    price: { type: "number", minimum: 0 },
                    cost: { type: "number", minimum: 0, default: 0 },
                    stock: { type: "number", default: 0 },
                    min_stock: { type: "number", default: 0 },
                    sold_by_weight: { type: "boolean", default: false },
                    category_id: { type: "string", format: "uuid" },
                    supplier_id: { type: "string", format: "uuid" },
                    image_url: { type: "string", format: "uri" },
                },
            },
            response: {
                201: {
                    description: "Producto creado exitosamente",
                    type: "object",
                    properties: {
                        success: { type: "boolean" },
                        data: { type: "object", properties: productProperties },
                    },
                },
                409: { description: "Código de barras ya registrado", ...errorResponse },
            },
        },
        preHandler: [authHook, requirePermission('products', 'create')]
    }, async (req, res) => {
        const user = req.user;
        const body = productSchema.parse(req.body);
        if (body.barcode) {
            const exist = await tenantStorage.run(user.tenantId, () => prisma.product.findFirst({
                where: { barcode: body.barcode, tenant_id: user.tenantId }
            }));
            if (exist) {
                return res.code(409).send({
                    success: false,
                    error: { code: 'CONFICT', message: 'Ya existe un producto con ese código de barras' }
                });
            }
        }
        const product = await tenantStorage.run(user.tenantId, () => prisma.product.create({
            data: { ...body, tenant_id: user.tenantId }
        }));
        return res.code(201).send({ success: true, data: product });
    });
    // PUT /products/:id
    app.put('/:id', {
        schema: {
            tags: ["Products"],
            summary: "Actualizar producto",
            description: "Actualiza parcialmente los campos de un producto existente.",
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
                    barcode: { type: "string", maxLength: 100 },
                    sku: { type: "string", maxLength: 100 },
                    name: { type: "string", minLength: 1, maxLength: 300 },
                    description: { type: "string" },
                    unit: {
                        type: "string",
                        enum: ["pza", "kg", "g", "lt", "ml", "caja", "paq", "rollo", "par"],
                    },
                    price: { type: "number", minimum: 0 },
                    cost: { type: "number", minimum: 0 },
                    stock: { type: "number" },
                    min_stock: { type: "number" },
                    sold_by_weight: { type: "boolean" },
                    category_id: { type: "string", format: "uuid" },
                    supplier_id: { type: "string", format: "uuid" },
                    image_url: { type: "string", format: "uri" },
                },
            },
            response: {
                200: {
                    description: "Producto actualizado",
                    type: "object",
                    properties: {
                        success: { type: "boolean" },
                        data: { type: "object", properties: productProperties },
                    },
                },
                404: { description: "Producto no encontrado", ...errorResponse },
            },
        },
        preHandler: [authHook, requirePermission('products', 'update')]
    }, async (req, res) => {
        const user = req.user;
        const { id } = req.params;
        const body = productSchema.partial().parse(req.body);
        const existing = await tenantStorage.run(user.tenantId, () => prisma.product.findFirst({ where: { id, tenant_id: user.tenantId } }));
        if (!existing) {
            return res.code(404).send({
                success: false,
                error: { code: 'NOT_FOUND', message: 'Producto no encontrado' },
            });
        }
        const product = await tenantStorage.run(user.tenantId, () => prisma.product.update({ where: { id }, data: body }));
        return res.send({ success: true, data: product });
    });
    // DELETE /products/:id
    app.delete('/:id', {
        schema: {
            tags: ["Products"],
            summary: "Desactivar producto",
            description: "Realiza un soft delete del producto (is_active = false). No elimina el registro.",
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
                    description: "Producto desactivado",
                    type: "object",
                    properties: {
                        success: { type: "boolean" },
                        data: {
                            type: "object",
                            properties: { message: { type: "string" } },
                        },
                    },
                },
                404: { description: "Producto no encontrado", ...errorResponse },
            },
        },
        preHandler: [authHook, requirePermission('products', 'delete')],
    }, async (req, res) => {
        const user = req.user;
        const { id } = req.params;
        const existing = await tenantStorage.run(user.tenantId, () => prisma.product.findFirst({ where: { id, tenant_id: user.tenantId } }));
        if (!existing) {
            return res.code(404).send({
                success: false,
                error: { code: 'NOT_FOUND', message: 'Producto no encontrado' },
            });
        }
        await tenantStorage.run(user.tenantId, () => prisma.product.update({ where: { id }, data: { is_active: false } }));
        return res.send({ success: true, data: { message: 'Producto desactivado' } });
    });
    // POST /products/import/csv
    app.post('/import/csv', {
        schema: {
            tags: ["Products"],
            summary: "Importar productos desde CSV",
            description: `Importa productos masivamente desde un archivo CSV (multipart/form-data).
**Columnas requeridas:** \`name\`, \`price\`

**Columnas opcionales:** \`barcode\`, \`sku\`, \`cost\`, \`stock\`, \`min_stock\`, \`unit\`, \`description\`, \`sold_by_weight\`

Si un producto ya existe (por barcode), se actualiza. Requiere el feature \`csv_import\` en el plan.`,
            security: [{ bearerAuth: [] }],
            consumes: ["multipart/form-data"],
            response: {
                200: {
                    description: "Importación completada",
                    type: "object",
                    properties: {
                        success: { type: "boolean" },
                        data: {
                            type: "object",
                            properties: {
                                message: { type: "string" },
                                created: { type: "integer" },
                                updated: { type: "integer" },
                                errors: { type: "array", items: { type: "string" } },
                            },
                        },
                    },
                },
                400: { description: "Archivo inválido o columnas faltantes", ...errorResponse },
            },
        },
        preHandler: [
            authHook,
            requirePermission('inventory', 'import'),
            requireFeature('csv_import'),
        ],
    }, async (request, reply) => {
        const user = request.user;
        const data = await request.file();
        if (!data) {
            return reply.code(400).send({
                success: false,
                error: { code: 'BAD_REQUEST', message: 'No se recibió ningún archivo' },
            });
        }
        const buffer = await data.toBuffer();
        let records;
        try {
            records = csvParse(buffer, {
                columns: true,
                skip_empty_lines: true,
                trim: true,
            });
        }
        catch {
            return reply.code(400).send({
                success: false,
                error: { code: 'INVALID_CSV', message: 'El archivo CSV no tiene un formato válido' },
            });
        }
        // Columnas requeridas
        const required = ['name', 'price'];
        const headers = Object.keys(records[0] ?? {});
        const missing = required.filter((col) => !headers.includes(col));
        if (missing.length > 0) {
            return reply.code(400).send({
                success: false,
                error: {
                    code: 'INVALID_CSV',
                    message: `Columnas requeridas faltantes: ${missing.join(', ')}`,
                },
            });
        }
        const results = { created: 0, updated: 0, errors: [] };
        for (let i = 0; i < records.length; i++) {
            const row = records[i];
            try {
                const parsed = productSchema.parse({
                    name: row.name,
                    barcode: row.barcode || undefined,
                    sku: row.sku || undefined,
                    price: Number(row.price),
                    cost: Number(row.cost ?? 0),
                    stock: Number(row.stock ?? 0),
                    min_stock: Number(row.min_stock ?? 0),
                    unit: row.unit || 'pza',
                    description: row.description || undefined,
                    sold_by_weight: row.sold_by_weight === 'true' || row.sold_by_weight === '1',
                });
                if (parsed.barcode) {
                    const existing = await tenantStorage.run(user.tenantId, () => prisma.product.findFirst({
                        where: { barcode: parsed.barcode, tenant_id: user.tenantId },
                    }));
                    if (existing) {
                        await tenantStorage.run(user.tenantId, () => prisma.product.update({ where: { id: existing.id }, data: parsed }));
                        results.updated++;
                        continue;
                    }
                }
                await tenantStorage.run(user.tenantId, () => prisma.product.create({ data: { ...parsed, tenant_id: user.tenantId } }));
                results.created++;
            }
            catch (err) {
                results.errors.push(`Fila ${i + 2}: ${err.message}`);
            }
        }
        return reply.send({
            success: true,
            data: {
                message: `Importación completada: ${results.created} creados, ${results.updated} actualizados`,
                ...results,
            },
        });
    });
}
//# sourceMappingURL=products.routes.js.map
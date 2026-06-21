import { z } from 'zod';
import prisma, { tenantStorage } from '../../lib/prisma.js';
import { requirePermission } from '../../middleware/authorize.js';
// ─── Schemas ──────────────────────────────────────────────────────────────────
const saleItemSchema = z.object({
    product_id: z.string().uuid(),
    quantity: z.number().positive(),
    unit_price: z.number().min(0),
    discount: z.number().min(0).default(0),
});
const paymentSchema = z.object({
    method: z.enum(['cash', 'card', 'transfer', 'credit']),
    amount: z.number().positive(),
    change_given: z.number().min(0).default(0),
    stripe_payment_id: z.string().optional(),
    stripe_terminal_id: z.string().optional(),
    card_last4: z.string().length(4).optional(),
    card_brand: z.string().optional(),
});
const createSaleSchema = z.object({
    branch_id: z.string().uuid(),
    customer_id: z.string().uuid().optional(),
    items: z.array(saleItemSchema).min(1),
    payments: z.array(paymentSchema).min(1),
    discount: z.number().min(0).default(0),
    notes: z.string().optional(),
});
const querySchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
    from: z.string().optional(),
    to: z.string().optional(),
    branch_id: z.string().uuid().optional(),
    user_id: z.string().uuid().optional(),
    status: z.enum(['pending', 'completed', 'canceled', 'returned']).optional(),
});
// ─── Shared schema fragments ───────────────────────────────────────────────────
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
};
// ─── Helper: generar folio secuencial por tenant ───────────────────────────────
async function generateFolio(tenantId) {
    const last = await tenantStorage.run(tenantId, () => prisma.sale.findFirst({
        where: { tenant_id: tenantId },
        orderBy: { created_at: 'desc' },
        select: { folio: true },
    }));
    const lastNum = last ? parseInt(last.folio.replace('VTA-', ''), 10) : 0;
    return `VTA-${String(lastNum + 1).padStart(6, '0')}`;
}
// ─── Rutas ────────────────────────────────────────────────────────────────────
export async function salesRoutes(app) {
    const authHook = async (req, rep) => {
        try {
            await req.jwtVerify();
        }
        catch {
            return rep.code(401).send();
        }
    };
    // GET /sales
    app.get('/', {
        schema: {
            tags: ['Sales'],
            summary: 'Listar ventas',
            description: `Retorna la lista paginada de ventas del tenant.
Los cajeros solo pueden ver sus propias ventas.`,
            security: [{ bearerAuth: [] }],
            querystring: {
                type: 'object',
                properties: {
                    page: { type: 'integer', minimum: 1, default: 1 },
                    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
                    from: { type: 'string', format: 'date-time', description: 'Fecha inicio (ISO 8601)' },
                    to: { type: 'string', format: 'date-time', description: 'Fecha fin (ISO 8601)' },
                    branch_id: { type: 'string', format: 'uuid' },
                    user_id: { type: 'string', format: 'uuid' },
                    status: {
                        type: 'string',
                        enum: ['pending', 'completed', 'canceled', 'returned'],
                    },
                },
            },
            response: {
                200: {
                    description: 'Lista de ventas',
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' },
                        data: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    id: { type: 'string' },
                                    folio: { type: 'string' },
                                    status: { type: 'string' },
                                    subtotal: { type: 'number' },
                                    discount: { type: 'number' },
                                    total: { type: 'number' },
                                    notes: { type: 'string', nullable: true },
                                    created_at: { type: 'string', format: 'date-time' },
                                    user: { type: 'object', properties: { full_name: { type: 'string' } } },
                                    customer: { type: 'object', nullable: true, properties: { name: { type: 'string' } } },
                                    branch: { type: 'object', properties: { name: { type: 'string' } } },
                                    payments: {
                                        type: 'array',
                                        items: {
                                            type: 'object',
                                            properties: {
                                                method: { type: 'string' },
                                                amount: { type: 'number' },
                                            },
                                        },
                                    },
                                    _count: {
                                        type: 'object',
                                        properties: { items: { type: 'integer' } },
                                    },
                                },
                            },
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
        preHandler: [authHook, requirePermission('sales', 'read')],
    }, async (req, res) => {
        const user = req.user;
        const query = querySchema.parse(req.query);
        const { page, limit, from, to, branch_id, status } = query;
        const where = { tenant_id: user.tenantId };
        if (from || to) {
            where.created_at = {};
            if (from)
                where.created_at.gte = new Date(from);
            if (to)
                where.created_at.lte = new Date(to);
        }
        if (branch_id)
            where.branch_id = branch_id;
        if (status)
            where.status = status;
        // Cajeros solo ven sus propias ventas
        if (user.roleCode === 'cashier') {
            where.user_id = user.sub;
        }
        const [sales, total] = await tenantStorage.run(user.tenantId, () => Promise.all([
            prisma.sale.findMany({
                where,
                include: {
                    user: { select: { full_name: true } },
                    customer: { select: { name: true } },
                    branch: { select: { name: true } },
                    payments: { select: { method: true, amount: true } },
                    _count: { select: { items: true } },
                },
                orderBy: { created_at: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
            }),
            prisma.sale.count({ where }),
        ]));
        return res.send({
            success: true,
            data: sales,
            meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
        });
    });
    // GET /sales/:id — detalle completo
    app.get('/:id', {
        schema: {
            tags: ['Sales'],
            summary: 'Obtener venta por ID',
            description: 'Retorna el detalle completo de una venta: items, pagos, cliente, cajero y sucursal.',
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
                    description: 'Detalle de la venta',
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' },
                        data: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                folio: { type: 'string' },
                                status: { type: 'string' },
                                subtotal: { type: 'number' },
                                discount: { type: 'number' },
                                total: { type: 'number' },
                                notes: { type: 'string', nullable: true },
                                created_at: { type: 'string', format: 'date-time' },
                                items: { type: 'array', items: { type: 'object' } },
                                payments: { type: 'array', items: { type: 'object' } },
                                customer: { type: 'object', nullable: true },
                                user: { type: 'object' },
                                branch: { type: 'object' },
                            },
                        },
                    },
                },
                404: { description: 'Venta no encontrada', ...errorResponse },
            },
        },
        preHandler: [authHook, requirePermission('sales', 'read')],
    }, async (req, res) => {
        const user = req.user;
        const { id } = req.params;
        const sale = await tenantStorage.run(user.tenantId, () => prisma.sale.findFirst({
            where: { id, tenant_id: user.tenantId },
            include: {
                items: {
                    include: {
                        product: { select: { name: true, barcode: true, unit: true } },
                    },
                },
                payments: true,
                user: { select: { full_name: true, email: true } },
                customer: true,
                branch: true,
            },
        }));
        if (!sale) {
            return res.code(404).send({
                success: false,
                error: { code: 'NOT_FOUND', message: 'Venta no encontrada' },
            });
        }
        return res.send({ success: true, data: sale });
    });
    // POST /sales — crear venta
    app.post('/', {
        schema: {
            tags: ['Sales'],
            summary: 'Crear venta',
            description: `Registra una nueva venta y descuenta el stock automáticamente.
Valida que los pagos cubran el total y que haya stock suficiente para cada producto.
Si el cliente tiene asociado el campo customer_id, acumula puntos de lealtad (1 punto por cada $10).`,
            security: [{ bearerAuth: [] }],
            body: {
                type: 'object',
                required: ['branch_id', 'items', 'payments'],
                properties: {
                    branch_id: { type: 'string', format: 'uuid' },
                    customer_id: { type: 'string', format: 'uuid', description: 'Opcional. Asocia la venta a un cliente.' },
                    discount: { type: 'number', minimum: 0, default: 0, description: 'Descuento global sobre el total' },
                    notes: { type: 'string' },
                    items: {
                        type: 'array',
                        minItems: 1,
                        items: {
                            type: 'object',
                            required: ['product_id', 'quantity', 'unit_price'],
                            properties: {
                                product_id: { type: 'string', format: 'uuid' },
                                quantity: { type: 'number', minimum: 0.001 },
                                unit_price: { type: 'number', minimum: 0 },
                                discount: { type: 'number', minimum: 0, default: 0 },
                            },
                        },
                    },
                    payments: {
                        type: 'array',
                        minItems: 1,
                        items: {
                            type: 'object',
                            required: ['method', 'amount'],
                            properties: {
                                method: { type: 'string', enum: ['cash', 'card', 'transfer', 'credit'] },
                                amount: { type: 'number', minimum: 0.01 },
                                change_given: { type: 'number', minimum: 0, default: 0 },
                                stripe_payment_id: { type: 'string' },
                                stripe_terminal_id: { type: 'string' },
                                card_last4: { type: 'string', minLength: 4, maxLength: 4 },
                                card_brand: { type: 'string' },
                            },
                        },
                    },
                },
            },
            response: {
                201: {
                    description: 'Venta creada exitosamente',
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' },
                        data: { type: 'object' },
                    },
                },
                400: { description: 'Stock insuficiente o datos inválidos', ...errorResponse },
                403: { description: 'Feature no disponible en el plan', ...errorResponse },
            },
        },
        preHandler: [authHook, requirePermission('sales', 'create')],
    }, async (req, res) => {
        const user = req.user;
        const body = createSaleSchema.parse(req.body);
        // Verificar que pagos con tarjeta tienen el feature activo
        const hasCardPayment = body.payments.some((p) => p.method === 'card');
        if (hasCardPayment) {
            const features = await prisma.$queryRaw `
        SELECT feature_key, limit_value FROM plataforma.get_tenant_features(${user.tenantId}::uuid)
        WHERE feature_key = 'card_payments'
      `;
            const cardEnabled = features.find((f) => f.feature_key === 'card_payments');
            if (!cardEnabled || cardEnabled.limit_value === 'false') {
                return res.code(403).send({
                    success: false,
                    error: {
                        code: 'FEATURE_NOT_AVAILABLE',
                        message: "Los pagos con tarjeta no están disponibles en tu plan",
                    },
                });
            }
        }
        // Ejecutar en transacción
        const sale = await tenantStorage.run(user.tenantId, () => prisma.$transaction(async (tx) => {
            // 1. Resolver productos y validar stock
            const productIds = body.items.map((i) => i.product_id);
            const products = await tx.product.findMany({
                where: { id: { in: productIds }, tenant_id: user.tenantId, is_active: true },
            });
            if (products.length !== productIds.length) {
                throw new Error('Uno o más productos no encontrados o inactivos');
            }
            const productMap = new Map(products.map((p) => [p.id, p]));
            // 2. Calcular totales y validar stock
            let subtotal = 0;
            const itemsToCreate = [];
            const movementsToCreate = [];
            for (const item of body.items) {
                const product = productMap.get(item.product_id);
                const currentStock = Number(product.stock);
                if (!product.sold_by_weight && currentStock < item.quantity) {
                    throw new Error(`Stock insuficiente para "${product.name}". Disponible: ${currentStock}`);
                }
                const itemSubtotal = item.quantity * item.unit_price - item.discount;
                subtotal += itemSubtotal;
                itemsToCreate.push({
                    product_id: item.product_id,
                    quantity: item.quantity,
                    unit_price: item.unit_price,
                    discount: item.discount,
                    subtotal: itemSubtotal,
                });
                movementsToCreate.push({
                    tenant_id: user.tenantId,
                    product_id: item.product_id,
                    user_id: user.sub,
                    branch_id: body.branch_id,
                    type: 'sale',
                    quantity_before: currentStock,
                    quantity_after: currentStock - item.quantity,
                    delta: -item.quantity,
                    reason: 'Venta',
                });
            }
            const total = subtotal - body.discount;
            // Validar que los pagos cubren el total
            const totalPaid = body.payments.reduce((sum, p) => sum + p.amount, 0);
            if (totalPaid < total) {
                throw new Error(`El total pagado (${totalPaid}) es menor al total de la venta (${total})`);
            }
            // 3. Generar folio
            const folio = await generateFolio(user.tenantId);
            // 4. Crear venta
            const newSale = await tx.sale.create({
                data: {
                    tenant_id: user.tenantId,
                    branch_id: body.branch_id,
                    user_id: user.sub,
                    customer_id: body.customer_id,
                    folio,
                    subtotal,
                    discount: body.discount,
                    total,
                    status: 'completed',
                    notes: body.notes,
                    items: { create: itemsToCreate },
                    payments: {
                        create: body.payments.map((p) => ({
                            tenant_id: user.tenantId,
                            method: p.method,
                            amount: p.amount,
                            change_given: p.change_given,
                            stripe_payment_id: p.stripe_payment_id,
                            stripe_terminal_id: p.stripe_terminal_id,
                            card_last4: p.card_last4,
                            card_brand: p.card_brand,
                            status: 'completed',
                        })),
                    },
                },
                include: {
                    items: { include: { product: { select: { name: true, unit: true } } } },
                    payments: true,
                    customer: { select: { name: true } },
                },
            });
            // 5. Descontar stock y registrar movimientos
            await Promise.all([
                ...body.items.map((item) => tx.product.update({
                    where: { id: item.product_id },
                    data: { stock: { decrement: item.quantity } },
                })),
                tx.inventoryMovement.createMany({
                    data: movementsToCreate.map((m) => ({
                        ...m,
                        reference_id: newSale.id,
                    })),
                }),
            ]);
            // 6. Actualizar puntos de lealtad del cliente
            if (body.customer_id) {
                const points = Math.floor(total / 10); // 1 punto por cada $10
                await tx.customer.update({
                    where: { id: body.customer_id },
                    data: { loyalty_points: { increment: points } },
                });
            }
            return newSale;
        }));
        return res.code(201).send({ success: true, data: sale });
    });
    // POST /sales/:id/cancel — cancelar venta y revertir stock
    app.post('/:id/cancel', {
        schema: {
            tags: ['Sales'],
            summary: 'Cancelar venta',
            description: 'Cancela una venta completada y revierte el stock de todos los productos involucrados.',
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
                required: ['reason'],
                properties: {
                    reason: { type: 'string', minLength: 1, description: 'Motivo de la cancelación' },
                },
            },
            response: {
                200: {
                    description: 'Venta cancelada y stock revertido',
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' },
                        data: {
                            type: 'object',
                            properties: { message: { type: 'string' } },
                        },
                    },
                },
                404: { description: 'Venta no encontrada o ya cancelada', ...errorResponse },
            },
        },
        preHandler: [authHook, requirePermission('sales', 'cancel')],
    }, async (req, res) => {
        const user = req.user;
        const { id } = req.params;
        const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body);
        await tenantStorage.run(user.tenantId, () => prisma.$transaction(async (tx) => {
            const sale = await tx.sale.findFirst({
                where: { id, tenant_id: user.tenantId, status: 'completed' },
                include: { items: true },
            });
            if (!sale)
                throw new Error('Venta no encontrada o ya cancelada');
            await tx.sale.update({ where: { id }, data: { status: 'canceled' } });
            // Revertir stock
            for (const item of sale.items) {
                const product = await tx.product.findUnique({ where: { id: item.product_id } });
                if (!product)
                    continue;
                await tx.product.update({
                    where: { id: item.product_id },
                    data: { stock: { increment: Number(item.quantity) } },
                });
                await tx.inventoryMovement.create({
                    data: {
                        tenant_id: user.tenantId,
                        product_id: item.product_id,
                        user_id: user.sub,
                        type: 'return',
                        quantity_before: Number(product.stock),
                        quantity_after: Number(product.stock) + Number(item.quantity),
                        delta: Number(item.quantity),
                        reason: `Cancelación de venta ${sale.folio}: ${reason}`,
                        reference_id: sale.id,
                    },
                });
            }
        }));
        return res.send({ success: true, data: { message: 'Venta cancelada y stock revertido' } });
    });
    // GET /sales/summary/today — resumen del día para dashboard
    app.get('/summary/today', {
        schema: {
            tags: ['Sales'],
            summary: 'Resumen de ventas del día',
            description: 'Retorna el total de ventas del día actual agrupado por método de pago. Útil para el dashboard del POS.',
            security: [{ bearerAuth: [] }],
            response: {
                200: {
                    description: 'Resumen del día',
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' },
                        data: {
                            type: 'object',
                            properties: {
                                totalSales: { type: 'integer', description: 'Número de ventas completadas hoy' },
                                totalAmount: { type: 'number', description: 'Monto total vendido hoy' },
                                byMethod: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            method: { type: 'string' },
                                            amount: { type: 'number' },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
        preHandler: [authHook, requirePermission('reports', 'view_sales')],
    }, async (req, res) => {
        const user = req.user;
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const [sales, payments] = await tenantStorage.run(user.tenantId, () => Promise.all([
            prisma.sale.aggregate({
                where: {
                    tenant_id: user.tenantId,
                    status: 'completed',
                    created_at: { gte: startOfDay },
                },
                _count: { id: true },
                _sum: { total: true },
            }),
            prisma.payment.groupBy({
                by: ['method'],
                where: {
                    tenant_id: user.tenantId,
                    status: 'completed',
                    created_at: { gte: startOfDay },
                },
                _sum: { amount: true },
            }),
        ]));
        return res.send({
            success: true,
            data: {
                totalSales: sales._count.id,
                totalAmount: Number(sales._sum.total ?? 0),
                byMethod: payments.map((p) => ({
                    method: p.method,
                    amount: Number(p._sum.amount ?? 0),
                })),
            },
        });
    });
}
//# sourceMappingURL=sales.routes.js.map
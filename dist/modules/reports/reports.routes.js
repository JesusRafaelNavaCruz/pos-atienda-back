import { z } from "zod";
import prisma, { tenantStorage } from "../../lib/prisma.js";
import { requirePermission, requireFeature, } from "../../middleware/authorize.js";
const dateRangeSchema = z.object({
    from: z.string(),
    to: z.string(),
    branch_id: z.string().uuid().optional(),
});
// ─── Shared querystring for date range ────────────────────────────────────────
const dateRangeQuerystring = {
    type: "object",
    required: ["from", "to"],
    properties: {
        from: {
            type: "string",
            format: "date-time",
            description: "Fecha inicio en ISO 8601 (ej. 2024-01-01T00:00:00Z)",
        },
        to: {
            type: "string",
            format: "date-time",
            description: "Fecha fin en ISO 8601 (ej. 2024-01-31T23:59:59Z)",
        },
        branch_id: { type: "string", format: "uuid", description: "Filtrar por sucursal" },
    },
};
export async function reportsRoutes(app) {
    const authHook = async (req, rep) => {
        try {
            await req.jwtVerify();
        }
        catch {
            return rep.code(401).send();
        }
    };
    // GET /reports/dashboard — métricas para el dashboard principal
    app.get("/dashboard", {
        schema: {
            tags: ["Reports"],
            summary: "Dashboard principal",
            description: `Retorna métricas clave para el dashboard:
- Ventas de hoy vs ayer (con % de crecimiento)
- Ventas del mes vs mes anterior
- Conteo de productos con stock bajo
- Top 5 productos más vendidos hoy
- Desglose de ventas de hoy por método de pago`,
            security: [{ bearerAuth: [] }],
            response: {
                200: {
                    description: "Métricas del dashboard",
                    type: "object",
                    properties: {
                        success: { type: "boolean" },
                        data: {
                            type: "object",
                            properties: {
                                today: {
                                    type: "object",
                                    properties: {
                                        sales: { type: "integer" },
                                        amount: { type: "number" },
                                        growthVsYesterday: { type: "number", nullable: true },
                                    },
                                },
                                month: {
                                    type: "object",
                                    properties: {
                                        sales: { type: "integer" },
                                        amount: { type: "number" },
                                        discount: { type: "number" },
                                        growthVsLastMonth: { type: "number", nullable: true },
                                    },
                                },
                                lowStockCount: { type: "integer" },
                                topProducts: { type: "array", items: { type: "object" } },
                                paymentMethods: { type: "array", items: { type: "object" } },
                            },
                        },
                    },
                },
            },
        },
        preHandler: [authHook, requirePermission("reports", "view_sales")],
    }, async (request, reply) => {
        const user = request.user;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
        const startOfLastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        const endOfLastMonth = new Date(today.getFullYear(), today.getMonth(), 0, 23, 59, 59);
        const [todaySales, yesterdaySales, monthSales, lastMonthSales, lowStockProducts, topProducts, paymentMethods,] = await tenantStorage.run(user.tenantId, () => Promise.all([
            // Ventas de hoy
            prisma.sale.aggregate({
                where: {
                    tenant_id: user.tenantId,
                    status: "completed",
                    created_at: { gte: today },
                },
                _count: { id: true },
                _sum: { total: true },
            }),
            // Ventas de ayer
            prisma.sale.aggregate({
                where: {
                    tenant_id: user.tenantId,
                    status: "completed",
                    created_at: { gte: yesterday, lt: today },
                },
                _count: { id: true },
                _sum: { total: true },
            }),
            // Ventas del mes
            prisma.sale.aggregate({
                where: {
                    tenant_id: user.tenantId,
                    status: "completed",
                    created_at: { gte: startOfMonth },
                },
                _count: { id: true },
                _sum: { total: true, discount: true },
            }),
            // Ventas del mes anterior
            prisma.sale.aggregate({
                where: {
                    tenant_id: user.tenantId,
                    status: "completed",
                    created_at: { gte: startOfLastMonth, lte: endOfLastMonth },
                },
                _count: { id: true },
                _sum: { total: true },
            }),
            // Productos con stock bajo
            prisma.product.count({
                where: {
                    tenant_id: user.tenantId,
                    is_active: true,
                    stock: { lte: prisma.product.fields.min_stock },
                },
            }),
            // Top 5 productos más vendidos hoy
            prisma.saleItem.groupBy({
                by: ["product_id"],
                where: {
                    sale: {
                        tenant_id: user.tenantId,
                        status: "completed",
                        created_at: { gte: today },
                    },
                },
                _sum: { quantity: true, subtotal: true },
                _count: { product_id: true },
                orderBy: { _sum: { subtotal: "desc" } },
                take: 5,
            }),
            // Ventas de hoy por método de pago
            prisma.payment.groupBy({
                by: ["method"],
                where: {
                    tenant_id: user.tenantId,
                    status: "completed",
                    created_at: { gte: today },
                },
                _sum: { amount: true },
            }),
        ]));
        // Resolver nombres de productos top
        const productIds = topProducts.map((tp) => tp.product_id);
        const products = productIds.length > 0
            ? await tenantStorage.run(user.tenantId, () => prisma.product.findMany({
                where: { id: { in: productIds } },
                select: { id: true, name: true, unit: true },
            }))
            : [];
        const productMap = new Map(products.map((p) => [p.id, p]));
        const todayTotal = Number(todaySales._sum.total ?? 0);
        const yesterdayTotal = Number(yesterdaySales._sum.total ?? 0);
        const monthTotal = Number(monthSales._sum.total ?? 0);
        const lastMonthTotal = Number(lastMonthSales._sum.total ?? 0);
        return reply.send({
            success: true,
            data: {
                today: {
                    sales: todaySales._count.id,
                    amount: todayTotal,
                    growthVsYesterday: yesterdayTotal > 0
                        ? ((todayTotal - yesterdayTotal) / yesterdayTotal) * 100
                        : null,
                },
                month: {
                    sales: monthSales._count.id,
                    amount: monthTotal,
                    discount: Number(monthSales._sum.discount ?? 0),
                    growthVsLastMonth: lastMonthTotal > 0
                        ? ((monthTotal - lastMonthTotal) / lastMonthTotal) * 100
                        : null,
                },
                lowStockCount: lowStockProducts,
                topProducts: topProducts.map((tp) => ({
                    product: productMap.get(tp.product_id),
                    quantity: Number(tp._sum.quantity ?? 0),
                    revenue: Number(tp._sum.subtotal ?? 0),
                })),
                paymentMethods: paymentMethods.map((pm) => ({
                    method: pm.method,
                    amount: Number(pm._sum.amount ?? 0),
                })),
            },
        });
    });
    // GET /reports/sales — reporte de ventas por rango de fecha
    app.get("/sales", {
        schema: {
            tags: ["Reports"],
            summary: "Reporte de ventas por período",
            description: `Retorna el análisis completo de ventas en un rango de fechas:
- Resumen total (ventas, ingresos, descuentos, ticket promedio)
- Ventas agrupadas por día
- Desglose por método de pago
- Top 10 cajeros por ventas

Los cajeros solo pueden ver sus propias ventas.`,
            security: [{ bearerAuth: [] }],
            querystring: dateRangeQuerystring,
            response: {
                200: {
                    description: "Reporte de ventas",
                    type: "object",
                    properties: {
                        success: { type: "boolean" },
                        data: {
                            type: "object",
                            properties: {
                                summary: {
                                    type: "object",
                                    properties: {
                                        totalSales: { type: "integer" },
                                        totalRevenue: { type: "number" },
                                        totalDiscount: { type: "number" },
                                        avgTicket: { type: "number" },
                                    },
                                },
                                byDay: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        properties: {
                                            day: { type: "string" },
                                            sales: { type: "integer" },
                                            total: { type: "number" },
                                        },
                                    },
                                },
                                byPaymentMethod: { type: "array", items: { type: "object" } },
                                byCashier: { type: "array", items: { type: "object" } },
                            },
                        },
                    },
                },
            },
        },
        preHandler: [authHook, requirePermission("reports", "view_sales")],
    }, async (request, reply) => {
        const user = request.user;
        const { from, to, branch_id } = dateRangeSchema.parse(request.query);
        const where = {
            tenant_id: user.tenantId,
            status: "completed",
            created_at: { gte: new Date(from), lte: new Date(to) },
        };
        if (branch_id)
            where.branch_id = branch_id;
        // Cajeros solo ven sus propias ventas
        if (user.roleCode === "cashier")
            where.user_id = user.sub;
        const [summary, byDay, byPaymentMethod, byUser] = await tenantStorage.run(user.tenantId, () => Promise.all([
            prisma.sale.aggregate({
                where,
                _count: { id: true },
                _sum: { total: true, subtotal: true, discount: true },
                _avg: { total: true },
            }),
            // Ventas agrupadas por día
            prisma.$queryRaw `
          SELECT
            DATE(created_at AT TIME ZONE 'America/Mexico_City') AS day,
            COUNT(*) AS sales,
            SUM(total)::numeric AS total
          FROM negocio.sales
          WHERE tenant_id = ${user.tenantId}::uuid
            AND status = 'completed'
            AND created_at BETWEEN ${new Date(from)} AND ${new Date(to)}
            ${branch_id ? prisma.$queryRaw `AND branch_id = ${branch_id}::uuid` : prisma.$queryRaw ``}
          GROUP BY day
          ORDER BY day ASC
        `,
            prisma.payment.groupBy({
                by: ["method"],
                where: {
                    tenant_id: user.tenantId,
                    status: "completed",
                    created_at: { gte: new Date(from), lte: new Date(to) },
                },
                _sum: { amount: true },
                _count: { id: true },
            }),
            prisma.sale.groupBy({
                by: ["user_id"],
                where,
                _count: { id: true },
                _sum: { total: true },
                orderBy: { _sum: { total: "desc" } },
                take: 10,
            }),
        ]));
        // Resolver nombres de usuarios
        const userIds = byUser.map((u) => u.user_id);
        const users = userIds.length > 0
            ? await tenantStorage.run(user.tenantId, () => prisma.user.findMany({
                where: { id: { in: userIds } },
                select: { id: true, full_name: true },
            }))
            : [];
        const userMap = new Map(users.map((u) => [u.id, u.full_name]));
        return reply.send({
            success: true,
            data: {
                summary: {
                    totalSales: summary._count.id,
                    totalRevenue: Number(summary._sum.total ?? 0),
                    totalDiscount: Number(summary._sum.discount ?? 0),
                    avgTicket: Number(summary._avg.total ?? 0),
                },
                byDay: byDay.map((d) => ({
                    day: d.day,
                    sales: Number(d.sales),
                    total: Number(d.total),
                })),
                byPaymentMethod: byPaymentMethod.map((pm) => ({
                    method: pm.method,
                    amount: Number(pm._sum.amount ?? 0),
                    count: pm._count.id,
                })),
                byCashier: byUser.map((u) => ({
                    userId: u.user_id,
                    userName: userMap.get(u.user_id) ?? "Desconocido",
                    sales: u._count.id,
                    total: Number(u._sum.total ?? 0),
                })),
            },
        });
    });
    // GET /reports/products — productos más vendidos (feature: advanced_reports)
    app.get("/products", {
        schema: {
            tags: ["Reports"],
            summary: "Productos más vendidos",
            description: `Retorna los productos más vendidos en el período con cálculo de rentabilidad.
Incluye: ingresos, costo, utilidad bruta y margen por producto.
Requiere el feature \`advanced_reports\` en el plan.`,
            security: [{ bearerAuth: [] }],
            querystring: {
                ...dateRangeQuerystring,
                properties: {
                    ...dateRangeQuerystring.properties,
                    limit: {
                        type: "integer",
                        minimum: 1,
                        maximum: 50,
                        default: 20,
                        description: "Cantidad de productos a retornar",
                    },
                },
            },
            response: {
                200: {
                    description: "Productos más vendidos con rentabilidad",
                    type: "object",
                    properties: {
                        success: { type: "boolean" },
                        data: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    product: { type: "object" },
                                    quantity: { type: "number" },
                                    revenue: { type: "number" },
                                    profit: { type: "number" },
                                    margin: { type: "number", description: "Margen bruto en %" },
                                },
                            },
                        },
                    },
                },
            },
        },
        preHandler: [
            authHook,
            requirePermission("reports", "view_sales"),
            requireFeature("advanced_reports"),
        ],
    }, async (request, reply) => {
        const user = request.user;
        const { from, to } = dateRangeSchema.parse(request.query);
        const { limit } = z
            .object({ limit: z.coerce.number().min(1).max(50).default(20) })
            .parse(request.query);
        const topItems = await tenantStorage.run(user.tenantId, () => prisma.saleItem.groupBy({
            by: ["product_id"],
            where: {
                sale: {
                    tenant_id: user.tenantId,
                    status: "completed",
                    created_at: { gte: new Date(from), lte: new Date(to) },
                },
            },
            _sum: { quantity: true, subtotal: true },
            _count: { product_id: true },
            orderBy: { _sum: { subtotal: "desc" } },
            take: limit,
        }));
        const productIds = topItems.map((i) => i.product_id);
        const products = await tenantStorage.run(user.tenantId, () => prisma.product.findMany({
            where: { id: { in: productIds } },
            select: {
                id: true,
                name: true,
                barcode: true,
                unit: true,
                cost: true,
                price: true,
            },
        }));
        const productMap = new Map(products.map((p) => [p.id, p]));
        return reply.send({
            success: true,
            data: topItems.map((item) => {
                const product = productMap.get(item.product_id);
                const revenue = Number(item._sum.subtotal ?? 0);
                const quantity = Number(item._sum.quantity ?? 0);
                const cost = product ? Number(product.cost) * quantity : 0;
                return {
                    product,
                    quantity,
                    revenue,
                    profit: revenue - cost,
                    margin: revenue > 0 ? ((revenue - cost) / revenue) * 100 : 0,
                };
            }),
        });
    });
    // GET /reports/cash-cut — corte de caja (Z-report)
    app.get("/cash-cut", {
        schema: {
            tags: ["Reports"],
            summary: "Corte de caja (Z-report)",
            description: `Genera el corte de caja para un período y sucursal.
Incluye: total de ventas, ingresos, descuentos, cancelaciones, efectivo en caja y desglose por método de pago.`,
            security: [{ bearerAuth: [] }],
            querystring: dateRangeQuerystring,
            response: {
                200: {
                    description: "Corte de caja",
                    type: "object",
                    properties: {
                        success: { type: "boolean" },
                        data: {
                            type: "object",
                            properties: {
                                period: { type: "object" },
                                branch_id: { type: "string", nullable: true },
                                totalSales: { type: "integer" },
                                totalRevenue: { type: "number" },
                                totalDiscount: { type: "number" },
                                totalCancellations: { type: "integer" },
                                cashInDrawer: {
                                    type: "number",
                                    description: "Efectivo en caja (cobrado menos cambio entregado)",
                                },
                                byPaymentMethod: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        properties: {
                                            method: { type: "string" },
                                            received: { type: "number" },
                                            change: { type: "number" },
                                            net: { type: "number" },
                                        },
                                    },
                                },
                                generatedAt: { type: "string", format: "date-time" },
                            },
                        },
                    },
                },
            },
        },
        preHandler: [authHook, requirePermission("reports", "view_sales")],
    }, async (request, reply) => {
        const user = request.user;
        const { from, to, branch_id } = dateRangeSchema.parse(request.query);
        const where = {
            tenant_id: user.tenantId,
            status: "completed",
            created_at: { gte: new Date(from), lte: new Date(to) },
        };
        if (branch_id)
            where.branch_id = branch_id;
        const paymentWhere = {
            tenant_id: user.tenantId,
            status: "completed",
            created_at: { gte: new Date(from), lte: new Date(to) },
        };
        const [sales, payments, cancellations] = await tenantStorage.run(user.tenantId, () => Promise.all([
            prisma.sale.aggregate({
                where,
                _count: { id: true },
                _sum: { total: true, discount: true },
            }),
            prisma.payment.groupBy({
                by: ["method"],
                where: paymentWhere,
                _sum: { amount: true, change_given: true },
            }),
            prisma.sale.count({
                where: { ...where, status: "canceled" },
            }),
        ]));
        const cashPayment = payments.find((p) => p.method === "cash");
        return reply.send({
            success: true,
            data: {
                period: { from, to },
                branch_id,
                totalSales: sales._count.id,
                totalRevenue: Number(sales._sum.total ?? 0),
                totalDiscount: Number(sales._sum.discount ?? 0),
                totalCancellations: cancellations,
                cashInDrawer: Number(cashPayment?._sum.amount ?? 0) -
                    Number(cashPayment?._sum.change_given ?? 0),
                byPaymentMethod: payments.map((p) => ({
                    method: p.method,
                    received: Number(p._sum.amount ?? 0),
                    change: Number(p._sum.change_given ?? 0),
                    net: Number(p._sum.amount ?? 0) - Number(p._sum.change_given ?? 0),
                })),
                generatedAt: new Date().toISOString(),
            },
        });
    });
    // GET /reports/inventory-value — valoración del inventario (advanced)
    app.get("/inventory-value", {
        schema: {
            tags: ["Reports"],
            summary: "Valoración del inventario",
            description: `Calcula el valor total del inventario activo en costo y precio de venta.
Retorna por producto: stock, costo unitario, precio de venta, valor total en costo, valor total en venta y utilidad potencial.
Requiere el feature \`advanced_reports\` en el plan.`,
            security: [{ bearerAuth: [] }],
            response: {
                200: {
                    description: "Valoración del inventario",
                    type: "object",
                    properties: {
                        success: { type: "boolean" },
                        data: {
                            type: "object",
                            properties: {
                                items: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        properties: {
                                            id: { type: "string" },
                                            name: { type: "string" },
                                            barcode: { type: "string", nullable: true },
                                            stock: { type: "number" },
                                            cost: { type: "number" },
                                            price: { type: "number" },
                                            totalCostValue: { type: "number" },
                                            totalSaleValue: { type: "number" },
                                            potentialProfit: { type: "number" },
                                            category: { type: "object", nullable: true },
                                        },
                                    },
                                },
                                totals: {
                                    type: "object",
                                    properties: {
                                        totalCostValue: { type: "number" },
                                        totalSaleValue: { type: "number" },
                                        potentialProfit: { type: "number" },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
        preHandler: [
            authHook,
            requirePermission("reports", "view_finance"),
            requireFeature("advanced_reports"),
        ],
    }, async (request, reply) => {
        const user = request.user;
        const products = await tenantStorage.run(user.tenantId, () => prisma.product.findMany({
            where: { tenant_id: user.tenantId, is_active: true },
            select: {
                id: true,
                name: true,
                barcode: true,
                stock: true,
                cost: true,
                price: true,
                category: { select: { name: true } },
            },
        }));
        const items = products.map((p) => ({
            ...p,
            stock: Number(p.stock),
            cost: Number(p.cost),
            price: Number(p.price),
            totalCostValue: Number(p.stock) * Number(p.cost),
            totalSaleValue: Number(p.stock) * Number(p.price),
            potentialProfit: Number(p.stock) * (Number(p.price) - Number(p.cost)),
        }));
        const totals = items.reduce((acc, item) => ({
            totalCostValue: acc.totalCostValue + item.totalCostValue,
            totalSaleValue: acc.totalSaleValue + item.totalSaleValue,
            potentialProfit: acc.potentialProfit + item.potentialProfit,
        }), { totalCostValue: 0, totalSaleValue: 0, potentialProfit: 0 });
        return reply.send({
            success: true,
            data: { items, totals },
        });
    });
}
//# sourceMappingURL=reports.routes.js.map
import { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma, { tenantStorage } from "../../lib/prisma.js";
import { requirePermission, requireFeature, } from "../../middleware/authorize.js";
function getPeriodRange(period) {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    switch (period) {
        case "today":
            return {
                from: d,
                to: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1),
                prevFrom: new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1),
                prevTo: d,
                label: "Hoy",
            };
        case "week": {
            const ws = new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
            return {
                from: ws,
                to: new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + 7),
                prevFrom: new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() - 7),
                prevTo: ws,
                label: "Esta semana",
            };
        }
        case "month":
            return {
                from: new Date(now.getFullYear(), now.getMonth(), 1),
                to: new Date(now.getFullYear(), now.getMonth() + 1, 1),
                prevFrom: new Date(now.getFullYear(), now.getMonth() - 1, 1),
                prevTo: new Date(now.getFullYear(), now.getMonth(), 1),
                label: "Este mes",
            };
        case "year":
            return {
                from: new Date(now.getFullYear(), 0, 1),
                to: new Date(now.getFullYear() + 1, 0, 1),
                prevFrom: new Date(now.getFullYear() - 1, 0, 1),
                prevTo: new Date(now.getFullYear(), 0, 1),
                label: String(now.getFullYear()),
            };
    }
}
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
    // GET /reports/dashboard — KPIs del negocio por período
    app.get("/dashboard", {
        schema: {
            tags: ["Reports"],
            summary: "Dashboard principal",
            description: `KPIs del negocio para el período seleccionado (today/week/month/year).

Cada KPI incluye comparación vs el período anterior equivalente.
Las transacciones recientes son siempre las últimas 10, independiente del período.`,
            security: [{ bearerAuth: [] }],
            querystring: {
                type: "object",
                required: ["period"],
                properties: {
                    period: {
                        type: "string",
                        enum: ["today", "week", "month", "year"],
                        description: "Período para los KPIs",
                    },
                    branch_id: {
                        type: "string",
                        format: "uuid",
                        description: "Filtrar por sucursal",
                    },
                },
            },
            response: {
                200: {
                    type: "object",
                    properties: {
                        success: { type: "boolean" },
                        data: {
                            type: "object",
                            properties: {
                                period: {
                                    type: "object",
                                    properties: {
                                        label: { type: "string" },
                                        from: { type: "string" },
                                        to: { type: "string" },
                                    },
                                },
                                sales: {
                                    type: "object",
                                    properties: {
                                        count: { type: "integer" },
                                        revenue: { type: "number" },
                                        discount: { type: "number" },
                                        growthVsPrevious: { type: "number", nullable: true },
                                    },
                                },
                                avgTicket: {
                                    type: "object",
                                    properties: {
                                        value: { type: "number" },
                                        growthVsPrevious: { type: "number", nullable: true },
                                    },
                                },
                                profit: {
                                    type: "object",
                                    properties: {
                                        gross: { type: "number" },
                                        margin: { type: "number", description: "Margen bruto %" },
                                        growthVsPrevious: { type: "number", nullable: true },
                                    },
                                },
                                topProducts: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        properties: {
                                            product: {
                                                type: "object",
                                                nullable: true,
                                                properties: {
                                                    id: { type: "string" },
                                                    name: { type: "string" },
                                                    unit: { type: "string", nullable: true },
                                                },
                                            },
                                            quantity: { type: "number" },
                                            revenue: { type: "number" },
                                        },
                                    },
                                },
                                recentTransactions: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        properties: {
                                            id: { type: "string" },
                                            total: { type: "number" },
                                            cashier: { type: "string" },
                                            createdAt: { type: "string", format: "date-time" },
                                        },
                                    },
                                },
                                paymentMethods: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        properties: {
                                            method: { type: "string" },
                                            amount: { type: "number" },
                                            count: { type: "integer" },
                                        },
                                    },
                                },
                                alerts: {
                                    type: "object",
                                    properties: {
                                        lowStockCount: { type: "integer" },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
        preHandler: [authHook, requirePermission("reports", "view_sales")],
    }, async (request, reply) => {
        const user = request.user;
        const { period, branch_id } = z
            .object({
            period: z.enum(["today", "week", "month", "year"]),
            branch_id: z.string().optional(),
        })
            .parse(request.query);
        const { from, to, prevFrom, prevTo, label } = getPeriodRange(period);
        const saleWhere = {
            tenant_id: user.tenantId,
            status: "completed",
            created_at: { gte: from, lt: to },
        };
        if (branch_id)
            saleWhere.branch_id = branch_id;
        const prevSaleWhere = {
            ...saleWhere,
            created_at: { gte: prevFrom, lt: prevTo },
        };
        const branchFilter = branch_id
            ? Prisma.sql `AND s.branch_id = ${branch_id}::uuid`
            : Prisma.empty;
        const [salesAgg, prevSalesAgg, profitRows, prevProfitRows, topItemGroups, recentSales, paymentMethods, lowStockCount,] = await tenantStorage.run(user.tenantId, () => Promise.all([
            prisma.sale.aggregate({
                where: saleWhere,
                _count: { id: true },
                _sum: { total: true, discount: true },
                _avg: { total: true },
            }),
            prisma.sale.aggregate({
                where: prevSaleWhere,
                _sum: { total: true },
                _avg: { total: true },
            }),
            // Utilidad bruta del período actual
            prisma.$queryRaw `
            SELECT
              COALESCE(SUM(si.subtotal - si.quantity * p.cost), 0)::numeric AS gross_profit,
              COALESCE(SUM(si.subtotal), 0)::numeric AS revenue
            FROM negocio.sale_items si
            JOIN negocio.products p ON p.id = si.product_id
            JOIN negocio.sales s ON s.id = si.sale_id
            WHERE s.tenant_id = ${user.tenantId}::uuid
              AND s.status = 'completed'
              AND s.created_at >= ${from}
              AND s.created_at < ${to}
              ${branchFilter}
          `,
            // Utilidad bruta del período anterior
            prisma.$queryRaw `
            SELECT
              COALESCE(SUM(si.subtotal - si.quantity * p.cost), 0)::numeric AS gross_profit
            FROM negocio.sale_items si
            JOIN negocio.products p ON p.id = si.product_id
            JOIN negocio.sales s ON s.id = si.sale_id
            WHERE s.tenant_id = ${user.tenantId}::uuid
              AND s.status = 'completed'
              AND s.created_at >= ${prevFrom}
              AND s.created_at < ${prevTo}
              ${branchFilter}
          `,
            // Top 5 productos más vendidos del período
            prisma.saleItem.groupBy({
                by: ["product_id"],
                where: {
                    sale: {
                        tenant_id: user.tenantId,
                        status: "completed",
                        created_at: { gte: from, lt: to },
                    },
                },
                _sum: { quantity: true, subtotal: true },
                orderBy: { _sum: { subtotal: "desc" } },
                take: 5,
            }),
            // Últimas 10 transacciones (sin filtro de período)
            prisma.sale.findMany({
                where: { tenant_id: user.tenantId, status: "completed" },
                orderBy: { created_at: "desc" },
                take: 10,
                select: { id: true, total: true, created_at: true, user_id: true },
            }),
            // Métodos de pago del período
            prisma.payment.groupBy({
                by: ["method"],
                where: {
                    tenant_id: user.tenantId,
                    status: "completed",
                    created_at: { gte: from, lt: to },
                },
                _sum: { amount: true },
                _count: { id: true },
            }),
            // Productos con stock bajo (alerta permanente)
            prisma.product.count({
                where: {
                    tenant_id: user.tenantId,
                    is_active: true,
                    stock: { lte: prisma.product.fields.min_stock },
                },
            }),
        ]));
        // Resolver nombres de productos top
        const productIds = topItemGroups.map((i) => i.product_id);
        const products = productIds.length > 0
            ? await tenantStorage.run(user.tenantId, () => prisma.product.findMany({
                where: { id: { in: productIds } },
                select: { id: true, name: true, unit: true },
            }))
            : [];
        const productMap = new Map(products.map((p) => [p.id, p]));
        // Resolver nombres de cajeros de transacciones recientes
        const recentUserIds = [...new Set(recentSales.map((s) => s.user_id))];
        const recentUsers = recentUserIds.length > 0
            ? await tenantStorage.run(user.tenantId, () => prisma.user.findMany({
                where: { id: { in: recentUserIds } },
                select: { id: true, full_name: true },
            }))
            : [];
        const userMap = new Map(recentUsers.map((u) => [u.id, u.full_name]));
        const growth = (current, prev) => prev > 0 ? ((current - prev) / prev) * 100 : null;
        const currentRevenue = Number(salesAgg._sum.total ?? 0);
        const prevRevenue = Number(prevSalesAgg._sum.total ?? 0);
        const currentAvgTicket = Number(salesAgg._avg.total ?? 0);
        const prevAvgTicket = Number(prevSalesAgg._avg.total ?? 0);
        const currentProfit = Number(profitRows[0]?.gross_profit ?? 0);
        const prevProfit = Number(prevProfitRows[0]?.gross_profit ?? 0);
        const profitRevenue = Number(profitRows[0]?.revenue ?? 0);
        return reply.send({
            success: true,
            data: {
                period: { label, from: from.toISOString(), to: to.toISOString() },
                sales: {
                    count: salesAgg._count.id,
                    revenue: currentRevenue,
                    discount: Number(salesAgg._sum.discount ?? 0),
                    growthVsPrevious: growth(currentRevenue, prevRevenue),
                },
                avgTicket: {
                    value: currentAvgTicket,
                    growthVsPrevious: growth(currentAvgTicket, prevAvgTicket),
                },
                profit: {
                    gross: currentProfit,
                    margin: profitRevenue > 0 ? (currentProfit / profitRevenue) * 100 : 0,
                    growthVsPrevious: growth(currentProfit, prevProfit),
                },
                topProducts: topItemGroups.map((item) => ({
                    product: productMap.get(item.product_id),
                    quantity: Number(item._sum.quantity ?? 0),
                    revenue: Number(item._sum.subtotal ?? 0),
                })),
                recentTransactions: recentSales.map((s) => ({
                    id: s.id,
                    total: Number(s.total),
                    cashier: userMap.get(s.user_id) ?? "Desconocido",
                    createdAt: s.created_at,
                })),
                paymentMethods: paymentMethods.map((pm) => ({
                    method: pm.method,
                    amount: Number(pm._sum.amount ?? 0),
                    count: pm._count.id,
                })),
                alerts: { lowStockCount },
            },
        });
    });
    // GET /reports/sales — reporte de ventas por período o rango de fecha
    app.get("/sales", {
        schema: {
            tags: ["Reports"],
            summary: "Reporte de ventas",
            description: `Retorna el análisis completo de ventas.

Usa \`period\` para períodos predefinidos (today/week/month/year) o \`from\`+\`to\` para rango personalizado.

Cuando se usa \`period\`, la respuesta incluye:
- Comparación vs el período anterior (\`growthVsPrevious\`)
- Desglose por hora para \`today\`
- Desglose por mes para \`year\`

Los cajeros solo pueden ver sus propias ventas.`,
            security: [{ bearerAuth: [] }],
            querystring: {
                type: "object",
                properties: {
                    period: {
                        type: "string",
                        enum: ["today", "week", "month", "year"],
                        description: "Período predefinido (alternativa a from+to)",
                    },
                    from: {
                        type: "string",
                        format: "date-time",
                        description: "Fecha inicio ISO 8601 (requerido si no se usa period)",
                    },
                    to: {
                        type: "string",
                        format: "date-time",
                        description: "Fecha fin ISO 8601 (requerido si no se usa period)",
                    },
                    branch_id: { type: "string", format: "uuid", description: "Filtrar por sucursal" },
                },
            },
            response: {
                200: {
                    type: "object",
                    properties: {
                        success: { type: "boolean" },
                        data: {
                            type: "object",
                            properties: {
                                period: {
                                    type: "object",
                                    nullable: true,
                                    properties: {
                                        label: { type: "string" },
                                        from: { type: "string" },
                                        to: { type: "string" },
                                    },
                                },
                                summary: {
                                    type: "object",
                                    properties: {
                                        totalSales: { type: "integer" },
                                        totalRevenue: { type: "number" },
                                        totalDiscount: { type: "number" },
                                        avgTicket: { type: "number" },
                                        growthVsPrevious: { type: "number", nullable: true },
                                    },
                                },
                                byHour: {
                                    type: "array",
                                    nullable: true,
                                    items: {
                                        type: "object",
                                        properties: {
                                            hour: { type: "integer" },
                                            sales: { type: "integer" },
                                            total: { type: "number" },
                                        },
                                    },
                                },
                                byDay: {
                                    type: "array",
                                    nullable: true,
                                    items: {
                                        type: "object",
                                        properties: {
                                            day: { type: "string" },
                                            sales: { type: "integer" },
                                            total: { type: "number" },
                                        },
                                    },
                                },
                                byMonth: {
                                    type: "array",
                                    nullable: true,
                                    items: {
                                        type: "object",
                                        properties: {
                                            month: { type: "string" },
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
        const querySchema = z
            .object({
            period: z.enum(["today", "week", "month", "year"]).optional(),
            from: z.string().optional(),
            to: z.string().optional(),
            branch_id: z.string().uuid().optional(),
        })
            .refine((d) => d.period || (d.from && d.to), {
            message: "Proporciona 'period' o ambos 'from' y 'to'",
        });
        const query = querySchema.parse(request.query);
        let from;
        let to;
        let periodMeta = null;
        let prevFrom = null;
        let prevTo = null;
        if (query.period) {
            const range = getPeriodRange(query.period);
            from = range.from;
            to = range.to;
            prevFrom = range.prevFrom;
            prevTo = range.prevTo;
            periodMeta = { label: range.label, from: from.toISOString(), to: to.toISOString() };
        }
        else {
            from = new Date(query.from);
            to = new Date(query.to);
        }
        const branchFilter = query.branch_id
            ? Prisma.sql `AND branch_id = ${query.branch_id}::uuid`
            : Prisma.empty;
        const where = {
            tenant_id: user.tenantId,
            status: "completed",
            created_at: { gte: from, lt: to },
        };
        if (query.branch_id)
            where.branch_id = query.branch_id;
        if (user.roleCode === "cashier")
            where.user_id = user.sub;
        // Aggregations que siempre se ejecutan
        const baseQueries = tenantStorage.run(user.tenantId, () => Promise.all([
            prisma.sale.aggregate({
                where,
                _count: { id: true },
                _sum: { total: true, discount: true },
                _avg: { total: true },
            }),
            prisma.payment.groupBy({
                by: ["method"],
                where: {
                    tenant_id: user.tenantId,
                    status: "completed",
                    created_at: { gte: from, lt: to },
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
        // Desglose temporal según el período
        let timeBreakdownQuery;
        if (query.period === "today") {
            timeBreakdownQuery = tenantStorage.run(user.tenantId, () => prisma.$queryRaw `
            SELECT
              EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/Mexico_City')::int AS hour,
              COUNT(*)::int AS sales,
              SUM(total)::numeric AS total
            FROM negocio.sales
            WHERE tenant_id = ${user.tenantId}::uuid
              AND status = 'completed'
              AND created_at >= ${from}
              AND created_at < ${to}
              ${branchFilter}
            GROUP BY hour
            ORDER BY hour ASC
          `);
        }
        else if (query.period === "year") {
            timeBreakdownQuery = tenantStorage.run(user.tenantId, () => prisma.$queryRaw `
            SELECT
              TO_CHAR(created_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM') AS month,
              COUNT(*)::int AS sales,
              SUM(total)::numeric AS total
            FROM negocio.sales
            WHERE tenant_id = ${user.tenantId}::uuid
              AND status = 'completed'
              AND created_at >= ${from}
              AND created_at < ${to}
              ${branchFilter}
            GROUP BY month
            ORDER BY month ASC
          `);
        }
        else {
            timeBreakdownQuery = tenantStorage.run(user.tenantId, () => prisma.$queryRaw `
            SELECT
              DATE(created_at AT TIME ZONE 'America/Mexico_City') AS day,
              COUNT(*)::int AS sales,
              SUM(total)::numeric AS total
            FROM negocio.sales
            WHERE tenant_id = ${user.tenantId}::uuid
              AND status = 'completed'
              AND created_at >= ${from}
              AND created_at < ${to}
              ${branchFilter}
            GROUP BY day
            ORDER BY day ASC
          `);
        }
        // Comparación vs período anterior (solo cuando se usa period)
        const prevSummaryQuery = prevFrom && prevTo
            ? tenantStorage.run(user.tenantId, () => prisma.sale.aggregate({
                where: {
                    ...where,
                    created_at: { gte: prevFrom, lt: prevTo },
                },
                _sum: { total: true },
            }))
            : Promise.resolve(null);
        const [[summary, byPaymentMethod, byUser], timeBreakdown, prevSummary] = await Promise.all([baseQueries, timeBreakdownQuery, prevSummaryQuery]);
        // Resolver nombres de cajeros
        const userIds = byUser.map((u) => u.user_id);
        const users = userIds.length > 0
            ? await tenantStorage.run(user.tenantId, () => prisma.user.findMany({
                where: { id: { in: userIds } },
                select: { id: true, full_name: true },
            }))
            : [];
        const userMap = new Map(users.map((u) => [u.id, u.full_name]));
        const totalRevenue = Number(summary._sum.total ?? 0);
        const prevRevenue = prevSummary ? Number(prevSummary._sum.total ?? 0) : null;
        const growthVsPrevious = prevRevenue !== null && prevRevenue > 0
            ? ((totalRevenue - prevRevenue) / prevRevenue) * 100
            : null;
        const isToday = query.period === "today";
        const isYear = query.period === "year";
        const isDay = !isToday && !isYear;
        return reply.send({
            success: true,
            data: {
                period: periodMeta,
                summary: {
                    totalSales: summary._count.id,
                    totalRevenue,
                    totalDiscount: Number(summary._sum.discount ?? 0),
                    avgTicket: Number(summary._avg.total ?? 0),
                    growthVsPrevious,
                },
                byHour: isToday
                    ? timeBreakdown.map((r) => ({
                        hour: r.hour,
                        sales: Number(r.sales),
                        total: Number(r.total),
                    }))
                    : null,
                byDay: isDay
                    ? timeBreakdown.map((r) => ({
                        day: r.day,
                        sales: Number(r.sales),
                        total: Number(r.total),
                    }))
                    : null,
                byMonth: isYear
                    ? timeBreakdown.map((r) => ({
                        month: r.month,
                        sales: Number(r.sales),
                        total: Number(r.total),
                    }))
                    : null,
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
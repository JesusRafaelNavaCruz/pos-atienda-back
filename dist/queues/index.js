// src/queues/index.ts
// Definición de colas BullMQ para tareas asíncronas:
//   - stock-alerts: notificaciones de productos con stock bajo
//   - report-generation: generación de reportes pesados en background
import { Queue, Worker } from 'bullmq';
import prisma, { tenantStorage } from '../lib/prisma.js';
// Definición de colas
const connection = { url: process.env.REDIS_URL ?? 'redis://localhost:6379' };
export const stockAlertsQueue = new Queue('stock-alerts', { connection });
export const reportQueue = new Queue('report-generation', { connection });
// Worker: alertas de stock bajo
export function createStockAlertsWorker() {
    const worker = new Worker('stock-alerts', async (job) => {
        const { tenantId, productId, name, stock, minStock, unit } = job.data;
        // En producción: enviar email, push notification, SMS, etc.
        // Aquí se loguea y se podría integrar con SendGrid, Resend, etc.
        console.log(`[Stock Alert] Tenant: ${tenantId} | Producto: "${name}" | ` +
            `Stock: ${stock} ${unit} | Mínimo: ${minStock} ${unit}`);
        // Ejemplo de integración con un sistema de notificaciones interno:
        // await sendEmailAlert({ tenantId, productId, name, stock, minStock })
        return { processed: true, productId };
    }, { connection, concurrency: 5 });
    worker.on('completed', (job) => {
        console.log(`[Queue] Alerta de stock procesada: ${job.id}`);
    });
    worker.on('failed', (job, err) => {
        console.error(`[Queue] Error en alerta de stock ${job?.id}:`, err.message);
    });
    return worker;
}
// Helper: encolar alerta de stock tras una venta
export async function enqueueStockAlertsForSale(tenantId, productIds) {
    const products = await tenantStorage.run(tenantId, () => prisma.product.findMany({
        where: {
            id: { in: productIds },
            tenant_id: tenantId,
            is_active: true,
        },
        select: { id: true, name: true, stock: true, min_stock: true, unit: true },
    }));
    for (const p of products) {
        if (Number(p.stock) <= Number(p.min_stock)) {
            await stockAlertsQueue.add('stock-alert', {
                tenantId,
                productId: p.id,
                name: p.name,
                stock: Number(p.stock),
                minStock: Number(p.min_stock),
                unit: p.unit,
            }, {
                attempts: 3,
                backoff: { type: 'exponential', delay: 1000 },
                removeOnComplete: 100,
                removeOnFail: 50,
            });
        }
    }
}
// Plugin de Fastify para inicializar workers
export async function registerQueues(app) {
    const stockWorker = createStockAlertsWorker();
    app.addHook('onClose', async () => {
        await stockWorker.close();
        await stockAlertsQueue.close();
        await reportQueue.close();
    });
    app.log.info('[Queue] Workers de BullMQ iniciados');
}
//# sourceMappingURL=index.js.map
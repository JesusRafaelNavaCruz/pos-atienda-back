// src/lib/prisma.ts
// Cliente Prisma con middleware que inyecta el tenant_id en cada query
// para que el RLS de PostgreSQL funcione correctamente.
import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'node:async_hooks';
// Almacén del tenant_id activo por contexto de request
export const tenantStorage = new AsyncLocalStorage();
const globalForPrisma = globalThis;
export const prisma = globalForPrisma.prisma ?? new PrismaClient({
    log: process.env.NODE_ENV === 'development'
        ? ['query', 'error', 'warn']
        : ['error'],
});
// Middleware: antes de cada query, establece app.tenant_id en la sesión de PG
// Esto activa el Row-Level Security definido en el schema SQL.
prisma.$use(async (params, next) => {
    const tenantId = tenantStorage.getStore();
    if (tenantId) {
        // Solo aplica en el schema 'negocio' — plataforma no tiene RLS
        const negocioModels = [
            'Branch', 'Role', 'User', 'UserSession', 'Supplier',
            'Category', 'Product', 'InventoryMovement', 'Customer',
            'Sale', 'SaleItem', 'Payment', 'PurchaseOrder', 'PurchaseOrderItem',
        ];
        if (negocioModels.includes(params.model ?? '')) {
            await prisma.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
        }
    }
    return next(params);
});
if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = prisma;
}
export default prisma;
//# sourceMappingURL=prisma.js.map
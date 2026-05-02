import { Queue, Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
export declare const stockAlertsQueue: Queue<any, any, string, any, any, string>;
export declare const reportQueue: Queue<any, any, string, any, any, string>;
export interface StockAlertJob {
    tenantId: string;
    productId: string;
    name: string;
    stock: number;
    minStock: number;
    unit: string;
}
export interface ReportJob {
    tenantId: string;
    userId: string;
    type: 'sales' | 'inventory' | 'cash-cut';
    params: Record<string, string>;
}
export declare function createStockAlertsWorker(): Worker<StockAlertJob, any, string>;
export declare function enqueueStockAlertsForSale(tenantId: string, productIds: string[]): Promise<void>;
export declare function registerQueues(app: FastifyInstance): Promise<void>;
//# sourceMappingURL=index.d.ts.map
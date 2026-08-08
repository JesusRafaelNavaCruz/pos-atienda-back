import { CreateOrderDTO, MPResponse, Order } from "@/types/mercadopago/types";
import { getMPClient } from "./client";

export class OrderService {

    private client = getMPClient();

    async createOrder(data: CreateOrderDTO, idempotencyKey: string): Promise<MPResponse<Order>> {
        return this.client.post<Order>("/v1/orders", data, { idempotencyKey });
    }

    async getOrder(orderId: string): Promise<MPResponse<Order>> {
        return this.client.get<Order>(`/v1/orders/${orderId}`);
    }

    async cancelOrder(orderId: string, idempotencyKey: string, forceCancel: boolean = false): Promise<MPResponse<Order>> {
        const headers: Record<string, string> = {};
        if (forceCancel) {
        headers['x-allow-cancelable-status'] = 'at_terminal';
        }
        return this.client.post<Order>(`/v1/orders/${orderId}/cancel`, undefined, { idempotencyKey, headers });
    }

    // 4. Reembolsar una order (total o parcial)
    async refundOrder(orderId: string, idempotencyKey: string, amount?: string): Promise<MPResponse<Order>> {
        const data = amount ? { amount } : undefined;
        return this.client.post<Order>(`/v1/orders/${orderId}/refund`, data, { idempotencyKey });
    }
}



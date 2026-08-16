export interface MPRequestConfig {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  data?: any;
  params?: Record<string, any>;
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

export interface MPResponse<T = any> {
  data: T;
  status: number;
  headers: Headers;
  rateLimit?: {
    limit: number;
    remaining: number;
    reset: number;
  };
}

// DTO para crear una order (basado en la migración)
export interface CreateOrderDTO {
  type: 'point'; // Obligatorio
  external_reference: string; // Tu ID de orden/factura (máx 64 chars)
  description?: string; // Descripción del cobro
  transactions: {
    payments: Array<{
      amount: string; // Ej: "150.00"
    }>;
  };
  config: {
    point: {
      terminal_id: string; // ID de la terminal física
      print_on_terminal?: 'seller_ticket' | 'no_ticket'; // Control de impresión
    };
    payment_method?: {
      default_type?: 'credit_card' | 'debit_card' | 'qr';
    };
  };
  expiration_time?: string; // Ej: "PT15M" (15 minutos)
  integration_data?: {
    platform_id?: string;
    integrator_id?: string;
    sponsor?: { id: string };
  };
}

// Tipos de respuesta para una Order (basado en la documentación)
export interface Order {
  id: string; // Formato: ORD00001111222233334444555566
  status: 'created' | 'at_terminal' | 'processed' | 'failed' | 'canceled' | 'refunded' | 'expired' | 'action_required';
  status_detail: string;
  type: 'point';
  external_reference: string;
  description?: string;
  transactions: {
    payments: Array<{
      id: string;
      amount: string;
      paid_amount?: string;
      refunded_amount?: string;
      status: string;
      status_detail: string;
      payment_method?: {
        type: 'credit_card' | 'debit_card';
        installments: number;
        id: string;
      };
      card?: {
        first_digits: string;
        last_digits: string;
      };
      reference_id: string;
    }>;
    refunds?: Array<{
      id: string;
      transaction_id: string;
      reference_id: string;
      amount: string;
      status: 'processing' | 'processed';
    }>;
  };
  config: {
    point: {
      terminal_id: string;
      print_on_terminal: 'seller_ticket' | 'no_ticket';
      ticket_number?: string;
    };
  };
  expiration_time: string;
  created_date: string;
  last_updated_date: string;
  user_id: string;
  processing_mode: 'automatic';
  country_code: string;
  integration_data: {
    application_id: string;
    platform_id?: string;
    integrator_id?: string;
    sponsor?: { id: string };
  };
}

export interface Terminal {
  id: string;
  external_id: string;
  status: 'active' | 'inactive';
  category: 'device';
  name: string;
  store_id?: string;
  pos_id?: string;
  operating_mode?: 'PDV' | 'STANDALONE' | 'UNDEFINED';
  created_at: string;
  updated_at: string;
}

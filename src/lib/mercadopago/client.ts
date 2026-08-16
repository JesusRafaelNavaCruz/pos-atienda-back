import { envMP } from "@/config/mercadopago.config";
import { MPRequestConfig, MPResponse } from "@/types/mercadopago/types";

export class MPError extends Error {

    public readonly status: number;
    public readonly statusText: string;
    public readonly data: any;
    public readonly rateLimit?: { limit: number; remaining: number; reset: number}

    constructor(options: {
        status: number;
        statusText: string;
        data: any;
        rateLimit?: { limit: number; remaining: number; reset: number }
    }) {
        super(`MercadoPago error ${options.status}: ${options.statusText}`);
        this.name = "MPError";
        this.status = options.status;
        this.statusText = options.statusText;
        this.data = options.data;
        this.rateLimit = options.rateLimit;
    }
}

export class MercadoPagoClient {

    private readonly baseURL: string;
    private readonly accessToken: string;
    private readonly timeout: number;
    private readonly retryAttempts: number;
    private readonly retryDelay: number;

    constructor (accessToken: string) {
        this.baseURL = envMP.MP_API_URL;
        this.accessToken = accessToken;
        this.timeout = envMP.MP_TIMEOUT;
        this.retryAttempts = envMP.MP_RETRY_ATTEMPTS;
        this.retryDelay = envMP.MP_RETRY_DELAY;

        if (!this.accessToken) {
            throw new Error("MP_ACCESS_TOKEN Required");
        }
    }

    private getHeaders(idempotencyKey?: string, additionalHeaders?: Record<string, string>): Record<string, string> {
        const headers: Record<string, string> = {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        };

        if (idempotencyKey) {
            headers['X-Idempotency-Key'] = idempotencyKey;
        }

        if (additionalHeaders) {
            Object.assign(headers, additionalHeaders);
        }

        return headers;
    }

    private buildURL(path: string, params?: Record<string, any>): string {
        const url = new URL(path, this.baseURL);

        if (params) {
            Object.entries(params).forEach(([key, value]) => {
                if (value !== undefined && value !== null && value !== '') {
                    url.searchParams.append(key, String(value));
                }
            })
        }

        return url.toString();
    }

    private async handleResponse<T>(response: Response): Promise<MPResponse<T>> {
        
        let data: T;

        try {

            const contentType = response.headers.get("content-type");
            if (contentType?.includes('application/json')) {
                data = await response.json() as unknown as T;
            } else {
                data = await response.text() as unknown as T;
            }

        } catch (error) {
            data = {} as T; 
        }

        // Rate Limit
        const rateLimit = {
            limit: parseInt(response.headers.get('x-ratelimit-limit') || '0', 10),
            remaining: parseInt(response.headers.get('x-ratelimit-remaining') || '0', 1),
            reset: parseInt(response.headers.get('x-ratelimit-reset') || '0', 10),
        }

        if (!response.ok) {
            throw new MPError({
                status: response.status,
                statusText: response.statusText,
                data,
                rateLimit: rateLimit.limit > 0 ? rateLimit : undefined,
            })
        }

        return {
            data,
            status: response.status,
            headers: response.headers,
            rateLimit: rateLimit.limit > 0 ? rateLimit : undefined,
        };

    }

    private async delay(ms: number): Promise<void> {

        return new Promise(resolve => setTimeout(resolve, ms));

    }

    private shouldRetry(error: MPError, attempt: number): boolean {

        const retryableStatuses = [429, 500, 502, 503, 504];
        const isRetryable = retryableStatuses.includes(error.status) || error.status === 0;
        const hasRetriesLeft = attempt < this.retryAttempts;

        return isRetryable && hasRetriesLeft;
        
    }

    async request<T = any>(config: MPRequestConfig): Promise<MPResponse<T>> {

        const {
            method = "GET",
            path,
            data,
            params,
            idempotencyKey,
            headers: additionalHeaders
        } = config;

        const url = this.buildURL(path, params);
        const headers = this.getHeaders(idempotencyKey, additionalHeaders);

        let lastError: MPError | null = null;
        let attempt = 0;

        while(attempt <= this.retryAttempts) {

            try {

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), this.timeout);

                const response = await fetch(url, {
                    method,
                    headers,
                    body: data ? JSON.stringify(data) : undefined,
                    signal: controller.signal,
                });

                clearTimeout(timeoutId);

                return await this.handleResponse<T>(response);

            } catch(error: any) {

                attempt++;

                if (error.name === "AbortError") {  
                    throw new MPError({
                        status: 408,
                        statusText: "Request timeout",
                        data: { message: "La solicitud excedió el tiempo"}
                    });
                }

                if (error instanceof MPError) {
                    lastError = error;
                } else {
                    lastError = new MPError({
                        status: 0,
                        statusText: "Network Error",
                        data: { message: error.message || "Error de red desconocido" }
                    });
                }

                if (this.shouldRetry(lastError, attempt)) {
                    const delayMs = this.retryDelay * Math.pow(2, attempt - 1);
                    console.warn(`Reintentando petición (${attempt}/${this.retryAttempts}) en ${delayMs}ms...`);
                    await this.delay(delayMs);
                    continue;   
                }

                throw lastError

            }

        }

        throw lastError;

    }


    // Metodos HTTP
    async get<T = any>(path: string, config?: Omit<MPRequestConfig, 'method' | 'path'>): Promise<MPResponse<T>> {
        return this.request<T>({ ...config, method: 'GET', path });
    }

    async post<T = any>(path: string, data?: any, config?: Omit<MPRequestConfig, 'method' | 'path' | 'data'>): Promise<MPResponse<T>> {
        return this.request<T>({ ...config, method: 'POST', path, data });
    }

    async put<T = any>(path: string, data?: any, config?: Omit<MPRequestConfig, 'method' | 'path' | 'data'>): Promise<MPResponse<T>> {
        return this.request<T>({ ...config, method: 'PUT', path, data });
    }

    async delete<T = any>(path: string, config?: Omit<MPRequestConfig, 'method' | 'path'>): Promise<MPResponse<T>> {
        return this.request<T>({ ...config, method: 'DELETE', path });
    }

    async patch<T = any>(path: string, data?: any, config?: Omit<MPRequestConfig, 'method' | 'path' | 'data'>): Promise<MPResponse<T>> {
        return this.request<T>({ ...config, method: 'PATCH', path, data });
    }



}

export function getMPClient(accessToken: string): MercadoPagoClient {
    return new MercadoPagoClient(accessToken);
}

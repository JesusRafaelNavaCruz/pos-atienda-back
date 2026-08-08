import z from "zod";

export interface MercadoPagoConfig {
    publicKey: string;
    accessToken: string;
    webhookSecret: string;
    webHookUrl: string;
    timeout: number;
    retryAttempts: number;
    retryDelay: number;
    apiUrl: string;

}

const mercadoPagoConfigSchema = z.object({

    MP_PUBLIC_KEY:  z.string().startsWith("APP_USR"),
    MP_ACCESS_TOKEN: z.string().startsWith("APP_USR"),
    MP_WEBHOOK_SECRET: z.string(),
    MP_WEBHOOK_URL: z.string(),
    MP_TIMEOUT: z.coerce.number().default(30000),
    MP_RETRY_ATTEMPTS: z.coerce.number().default(3),
    MP_RETRY_DELAY: z.coerce.number().default(1000),
    MP_API_URL: z.string().default('https://api.mercadopago.com')

})

const parsed = mercadoPagoConfigSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('Variables de entorno inválidas:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const envMP = parsed.data
export type Env = typeof envMP
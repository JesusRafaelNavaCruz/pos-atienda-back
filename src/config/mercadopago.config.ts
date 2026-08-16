import z from "zod";

export interface MercadoPagoConfig {
    publicKey: string;
    clientId: string;
    clientSecret: string;
    webhookSecret: string;
    webHookUrl: string;
    timeout: number;
    retryAttempts: number;
    retryDelay: number;
    apiUrl: string;

}

const mercadoPagoConfigSchema = z.object({

    // Las credenciales nunca se devuelven al cliente. Se admiten credenciales
    // productivas y de prueba para poder validar la integración antes del go-live.
    MP_PUBLIC_KEY: z.string().min(1).optional(),
    MP_CLIENT_ID: z.string().min(1),
    MP_CLIENT_SECRET: z.string().min(1),
    MP_OAUTH_REDIRECT_URI: z.string().url(),
    MP_OAUTH_SUCCESS_URL: z.string().url(),
    MP_OAUTH_TEST_MODE: z.coerce.boolean().default(false),
    MP_TOKEN_ENCRYPTION_KEY: z.string().min(43),
    MP_WEBHOOK_SECRET: z.string().min(16),
    MP_WEBHOOK_URL: z.string().url(),
    MP_TIMEOUT: z.coerce.number().default(30000),
    MP_RETRY_ATTEMPTS: z.coerce.number().default(3),
    MP_RETRY_DELAY: z.coerce.number().default(1000),
    MP_API_URL: z.string().url().default('https://api.mercadopago.com')

})

const parsed = mercadoPagoConfigSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('Variables de entorno inválidas:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const envMP = parsed.data
export type Env = typeof envMP

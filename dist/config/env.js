// src/config/env.ts
import { z } from 'zod';
import 'dotenv/config';
const envSchema = z.object({
    // Servidor
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().default(3000),
    HOST: z.string().default('0.0.0.0'),
    API_PREFIX: z.string().default('/api/v1'),
    // Base de datos
    DATABASE_URL: z.string().url(),
    // JWT
    JWT_SECRET: z.string().min(8),
    JWT_EXPIRES_IN: z.string().default('15m'),
    JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
    // Redis
    REDIS_URL: z.string().default('redis://localhost:6379'),
    // Stripe
    STRIPE_SECRET_KEY: z.string().startsWith('sk_'),
    STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_'),
    STRIPE_PUBLISHABLE_KEY: z.string().startsWith('pk_'),
    // App
    BCRYPT_ROUNDS: z.coerce.number().default(12),
    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    RATE_LIMIT_MAX: z.coerce.number().default(100),
    RATE_LIMIT_WINDOW: z.string().default('1 minute'),
    FEATURE_CACHE_TTL: z.coerce.number().default(300),
});
const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
    console.error('❌  Variables de entorno inválidas:');
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
}
export const env = parsed.data;
//# sourceMappingURL=env.js.map
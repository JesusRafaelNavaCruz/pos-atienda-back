import 'dotenv/config';
export declare const env: {
    NODE_ENV: "development" | "production" | "test";
    PORT: number;
    HOST: string;
    API_PREFIX: string;
    DATABASE_URL: string;
    JWT_SECRET: string;
    JWT_EXPIRES_IN: string;
    JWT_REFRESH_EXPIRES_IN: string;
    REDIS_URL: string;
    STRIPE_SECRET_KEY: string;
    STRIPE_WEBHOOK_SECRET: string;
    STRIPE_PUBLISHABLE_KEY: string;
    BCRYPT_ROUNDS: number;
    CORS_ORIGINS: string;
    RATE_LIMIT_MAX: number;
    RATE_LIMIT_WINDOW: string;
    FEATURE_CACHE_TTL: number;
};
export type Env = typeof env;
//# sourceMappingURL=env.d.ts.map
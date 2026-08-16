import Fastify from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import fastifyRateLimit from "@fastify/rate-limit";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import { env } from "./config/env";
import fastifySwagger from "@fastify/swagger";
import { errorHandler } from "./plugins/error-handler";
import prisma from "./lib/prisma";
import getRedis from "./lib/redis";
import { registerQueues } from "./queues";
import fastifySwaggerUi from "@fastify/swagger-ui";
// Modulos
import { authRoutes } from "./modules/auth/auth.routes";
import { customerRoutes } from "./modules/customers/customers.routes";
import { inventoryRoutes } from "./modules/inventory/inventory.routes";
import { productsRoutes } from "./modules/products/products.routes";
import { usersRoutes } from "./modules/users/users.routes";
import { suppliersRoutes } from "./modules/suppliers/suppliers.routes";
import { purchaseOrdersRoutes } from "./modules/suppliers/purchase-orders.routes";
import { purchaseOrdersPublicRoutes } from "./modules/suppliers/purchase-orders.public.routes";
import { salesRoutes } from "./modules/sales/sales.routes";
import { subscriptionsRoutes } from "./modules/tenants/tenants.routes";
import { stripeWebhooksRoutes } from "./modules/tenants/stripe-webhooks.routes";
import { reportsRoutes } from "./modules/reports/reports.routes";
import { adminAuthRoutes } from "./modules/admin/admin.auth.routes";
import { adminRoutes } from "./modules/admin/admin.routes";
// Create instance of Fastify
const app = Fastify({
    logger: {
        level: env.NODE_ENV === "production" ? "info" : "debug",
        transport: env.NODE_ENV !== "production"
            ? {
                target: "pino-pretty",
                options: { colorize: true, translateTime: "SYS:standard" },
            }
            : undefined,
    },
    trustProxy: true,
    ajv: {
        customOptions: { removeAdditional: "all", coerceTypes: true },
    },
});
// Plugins Globales
await app.register(helmet, {
    contentSecurityPolicy: false,
});
await app.register(cors, {
    origin: env.CORS_ORIGINS.split(",").map((o) => o.trim()),
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
});
await app.register(fastifyRateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    keyGenerator: (req) => {
        const auth = req.headers.authorization;
        if (auth) {
            try {
                const payload = app.jwt.decode(auth.replace("Bearer ", ""));
                return payload?.tenantId ?? req.ip;
            }
            catch {
                return req.ip;
            }
        }
        return req.ip;
    },
});
await app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: { algorithm: "HS256" },
});
await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});
// Swagger Doc
await app.register(fastifySwagger, {
    openapi: {
        info: {
            title: "POS Abarrotes API",
            description: "API REST para el sistema POS multi-tenant",
            version: "1.0.0",
        },
        servers: [{ url: `http://localhost:${env.PORT}` }],
        components: {
            securitySchemes: {
                bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
            },
        },
        security: [{ bearerAuth: [] }],
    },
});
await app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list", deepLinking: true },
});
// Error handler
await app.register(errorHandler);
// Health check
app.get("/health", async () => {
    const redis = getRedis();
    let redisOk = false;
    let dbOk = false;
    try {
        await redis?.ping();
        redisOk = true;
    }
    catch { }
    try {
        await prisma.$queryRaw `SELECT 1`;
        dbOk = true;
    }
    catch { }
    return {
        status: dbOk && redisOk ? "ok" : "degraded",
        timestamp: new Date().toISOString(),
        services: {
            database: dbOk ? "ok" : "error",
            redis: redisOk ? "ok" : "error",
        },
        version: "1.0.0",
    };
});
// Workers de BullMQ
await registerQueues(app);
// Registro de rutas
const prefix = env.API_PREFIX;
await app.register(authRoutes, { prefix: `${prefix}/auth` });
await app.register(productsRoutes, { prefix: `${prefix}/products` });
await app.register(salesRoutes, { prefix: `${prefix}/sales` });
await app.register(inventoryRoutes, { prefix: `${prefix}/inventory` });
await app.register(suppliersRoutes, { prefix: `${prefix}/suppliers` });
await app.register(purchaseOrdersRoutes, { prefix: `${prefix}/purchase-orders` });
await app.register(purchaseOrdersPublicRoutes, { prefix: "/public/purchase-orders" });
await app.register(customerRoutes, { prefix: `${prefix}/customers` });
await app.register(usersRoutes, { prefix: `${prefix}/users` });
await app.register(reportsRoutes, { prefix: `${prefix}/reports` });
await app.register(subscriptionsRoutes, { prefix: `${prefix}/subscriptions` });
await app.register(stripeWebhooksRoutes, { prefix: "/webhooks" });
await app.register(adminAuthRoutes, { prefix: `${prefix}/admin/auth` });
await app.register(adminRoutes, { prefix: `${prefix}/admin` });
// Arranque del servidor
async function start() {
    try {
        // Verificar conexión a la BD
        await prisma.$connect();
        app.log.info("Conexión a PostgreSQL establecida");
        // Conectar Redis
        await getRedis()
            ?.connect()
            .catch(() => { });
        // Levantar servidor
        await app.listen({ port: env.PORT, host: env.HOST });
        app.log.info(`Servidor corriendo en http://${env.HOST}:${env.PORT}`);
        app.log.info(`Documentación: http://localhost:${env.PORT}/docs`);
        app.log.info(`Health check: http://localhost:${env.PORT}/health`);
    }
    catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}
// Graceful shutdown
const signals = ["SIGINT", "SIGTERM"];
signals.forEach((signal) => {
    process.on(signal, async () => {
        app.log.info(`Recibida señal ${signal}, cerrando servidor...`);
        await app.close();
        await prisma.$disconnect();
        process.exit(0);
    });
});
start();
export default app;
//# sourceMappingURL=server.js.map
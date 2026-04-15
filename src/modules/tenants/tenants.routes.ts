// src/modules/tenants/subscriptions.routes.ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import Stripe from "stripe";
import prisma, { tenantStorage } from "../../lib/prisma.js";
import { featureCache } from "../../lib/redis.js";
import { env } from "../../config/env.js";
import type { JwtPayload } from "../../types/index.js";

const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" });

const errorResponse = {
  type: "object",
  properties: {
    success: { type: "boolean" },
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
      },
    },
  },
};

export async function subscriptionsRoutes(app: FastifyInstance) {
  const authHook = async (req: any, rep: any) => {
    try {
      await req.jwtVerify();
    } catch {
      return rep.code(401).send();
    }
  };

  // Solo el owner puede gestionar suscripciones
  const ownerOnly = async (req: any, rep: any) => {
    const user = req.user as JwtPayload;
    if (user.roleCode !== "owner") {
      return rep.code(403).send({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: "Solo el dueño del negocio puede gestionar la suscripción",
        },
      });
    }
  };

  // GET /subscriptions/current — estado actual de la suscripción y features
  app.get(
    "/current",
    {
      schema: {
        tags: ["Subscriptions"],
        summary: "Suscripción y plan actual",
        description: `Retorna el estado de la suscripción activa del tenant, incluyendo:
- Datos de la suscripción (estado, período, trial)
- Detalles del plan (nombre, precio, límites)
- Uso actual vs límites (usuarios y sucursales)
- Features habilitados por el plan`,
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            description: "Suscripción actual",
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  subscription: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      status: { type: "string" },
                      currentPeriodEnd: { type: "string", format: "date-time", nullable: true },
                      trialEndsAt: { type: "string", format: "date-time", nullable: true },
                      canceledAt: { type: "string", format: "date-time", nullable: true },
                    },
                  },
                  plan: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      code: { type: "string" },
                      price_mxn: { type: "number" },
                      max_users: { type: "integer" },
                      max_branches: { type: "integer" },
                      features: { type: "object", additionalProperties: { type: "string" } },
                    },
                  },
                  usage: {
                    type: "object",
                    properties: {
                      users: {
                        type: "object",
                        properties: {
                          current: { type: "integer" },
                          max: { type: "integer" },
                        },
                      },
                      branches: {
                        type: "object",
                        properties: {
                          current: { type: "integer" },
                          max: { type: "integer" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          404: { description: "Sin suscripción activa", ...errorResponse },
        },
      },
      preHandler: [authHook],
    },
    async (req, res) => {
      const user = req.user as JwtPayload;

      const sub = await prisma.subscription.findFirst({
        where: { tenant_id: user.tenantId },
        orderBy: { created_at: "desc" },
        include: { plan: { include: { features: true } } },
      });

      if (!sub) {
        return res.code(404).send({
          success: false,
          error: {
            code: "NOT_FOUND",
            message: "No se encontró suscripción activa",
          },
        });
      }

      // Conteos actuales del tenant
      const [userCount, branchCount] = await tenantStorage.run(
        user.tenantId,
        () =>
          Promise.all([
            prisma.user.count({
              where: { tenant_id: user.tenantId, is_active: true },
            }),
            prisma.branch.count({
              where: { tenant_id: user.tenantId, is_active: true },
            }),
          ]),
      );

      return res.send({
        success: true,
        data: {
          subscription: {
            id: sub.id,
            status: sub.status,
            currentPeriodEnd: sub.current_period_end,
            trialEndsAt: sub.trial_ends_at,
            canceledAt: sub.canceled_at,
          },
          plan: {
            name: sub.plan.name,
            code: sub.plan.code,
            price_mxn: Number(sub.plan.price_mxn),
            max_users: sub.plan.max_users,
            max_branches: sub.plan.max_branches,
            features: Object.fromEntries(
              sub.plan.features.map((f) => [f.feature_key, f.limit_value]),
            ),
          },
          usage: {
            users: { current: userCount, max: sub.plan.max_users },
            branches: { current: branchCount, max: sub.plan.max_branches },
          },
        },
      });
    },
  );

  // GET /subscriptions/plans — listar todos los planes disponibles
  app.get("/plans", {
    schema: {
      tags: ["Subscriptions"],
      summary: "Listar planes disponibles",
      description: "Retorna todos los planes activos de la plataforma con sus precios, límites y features. No requiere autenticación.",
      security: [],
      response: {
        200: {
          description: "Lista de planes",
          type: "object",
          properties: {
            success: { type: "boolean" },
            data: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  code: { type: "string" },
                  price_mxn: { type: "number" },
                  billing_interval: { type: "string" },
                  max_users: { type: "integer" },
                  max_branches: { type: "integer" },
                  trial_days: { type: "integer" },
                  features: {
                    type: "object",
                    additionalProperties: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
  }, async (_req, res) => {
    const plans = await prisma.plan.findMany({
      where: { is_active: true },
      include: { features: true },
      orderBy: { price_mxn: "asc" },
    });

    return res.send({
      success: true,
      data: plans.map((p) => ({
        id: p.id,
        name: p.name,
        code: p.code,
        price_mxn: Number(p.price_mxn),
        billing_interval: p.billing_interval,
        max_users: p.max_users,
        max_branches: p.max_branches,
        trial_days: p.trial_days,
        features: Object.fromEntries(
          p.features.map((f) => [f.feature_key, f.limit_value]),
        ),
      })),
    });
  });

  // POST /subscriptions/checkout — crear sesión de pago en Stripe
  app.post(
    "/checkout",
    {
      schema: {
        tags: ["Subscriptions"],
        summary: "Crear sesión de pago (Stripe Checkout)",
        description: `Crea una sesión de Stripe Checkout para suscribirse a un plan de pago.
Solo el owner del tenant puede iniciar una suscripción.
Retorna la URL a la que se debe redirigir al usuario para completar el pago.`,
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["plan_code", "success_url", "cancel_url"],
          properties: {
            plan_code: {
              type: "string",
              enum: ["pro", "enterprise"],
              description: "Código del plan al que se desea suscribir",
            },
            success_url: {
              type: "string",
              format: "uri",
              description: "URL de redirección al completar el pago",
            },
            cancel_url: {
              type: "string",
              format: "uri",
              description: "URL de redirección si el usuario cancela",
            },
          },
        },
        response: {
          200: {
            description: "Sesión de Stripe Checkout creada",
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  checkoutUrl: { type: "string", description: "URL de pago de Stripe" },
                  sessionId: { type: "string" },
                },
              },
            },
          },
          403: { description: "Solo el owner puede gestionar suscripciones", ...errorResponse },
          404: { description: "Plan no encontrado", ...errorResponse },
        },
      },
      preHandler: [authHook, ownerOnly],
    },
    async (req, res) => {
      const user = req.user as JwtPayload;
      const { plan_code, success_url, cancel_url } = z
        .object({
          plan_code: z.enum(["pro", "enterprise"]),
          success_url: z.string().url(),
          cancel_url: z.string().url(),
        })
        .parse(req.body);

      const plan = await prisma.plan.findFirst({
        where: { code: plan_code, is_active: true },
      });
      if (!plan) {
        return res.code(404).send({
          success: false,
          error: { code: "NOT_FOUND", message: "Plan no encontrado" },
        });
      }

      const tenant = await prisma.tenant.findUnique({
        where: { id: user.tenantId },
      });
      if (!tenant) return res.code(404).send();

      // Obtener o crear customer de Stripe
      const existingSub = await prisma.subscription.findFirst({
        where: { tenant_id: user.tenantId },
      });

      let customerId = existingSub?.stripe_customer_id;
      if (!customerId) {
        const customer = await stripe.customers.create({
          name: tenant.name,
          metadata: { tenant_id: user.tenantId },
        });
        customerId = customer.id;
      }

      // Crear sesión de Checkout de Stripe
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: "subscription",
        line_items: [
          {
            price_data: {
              currency: "mxn",
              product_data: { name: `POS Abarrotes — Plan ${plan.name}` },
              unit_amount: Math.round(Number(plan.price_mxn) * 100),
              recurring: {
                interval: plan.billing_interval === "monthly" ? "month" : "year",
              },
            },
            quantity: 1,
          },
        ],
        subscription_data: {
          metadata: { tenant_id: user.tenantId, plan_code },
          trial_period_days: plan.trial_days,
        },
        success_url,
        cancel_url,
      });

      return res.send({
        success: true,
        data: { checkoutUrl: session.url, sessionId: session.id },
      });
    },
  );

  // POST /subscriptions/portal — portal de Stripe para gestionar facturación
  app.post(
    "/portal",
    {
      schema: {
        tags: ["Subscriptions"],
        summary: "Abrir portal de facturación (Stripe)",
        description: `Crea una sesión del portal de facturación de Stripe donde el cliente puede:
gestionar su suscripción, actualizar método de pago, descargar facturas, etc.
Solo el owner del tenant puede acceder.`,
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["return_url"],
          properties: {
            return_url: {
              type: "string",
              format: "uri",
              description: "URL a la que se redirige al salir del portal",
            },
          },
        },
        response: {
          200: {
            description: "URL del portal de Stripe generada",
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  portalUrl: { type: "string", description: "URL del portal de Stripe" },
                },
              },
            },
          },
          400: { description: "Sin suscripción de Stripe activa", ...errorResponse },
          403: { description: "Solo el owner puede gestionar suscripciones", ...errorResponse },
        },
      },
      preHandler: [authHook, ownerOnly],
    },
    async (req, res) => {
      const user = req.user as JwtPayload;
      const { return_url } = z
        .object({ return_url: z.string().url() })
        .parse(req.body);

      const sub = await prisma.subscription.findFirst({
        where: { tenant_id: user.tenantId },
      });

      if (!sub?.stripe_customer_id) {
        return res.code(400).send({
          success: false,
          error: {
            code: "BAD_req",
            message: "No tienes una suscripción de Stripe activa",
          },
        });
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: sub.stripe_customer_id,
        return_url,
      });

      return res.send({ success: true, data: { portalUrl: session.url } });
    },
  );

  // POST /subscriptions/cancel — solicitar cancelación al final del período
  app.post(
    "/cancel",
    {
      schema: {
        tags: ["Subscriptions"],
        summary: "Cancelar suscripción",
        description: `Programa la cancelación de la suscripción al final del período de facturación actual.
El servicio sigue activo hasta la fecha de vencimiento.
Solo el owner puede cancelar.`,
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            description: "Cancelación programada exitosamente",
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  message: { type: "string" },
                  endsAt: {
                    type: "string",
                    format: "date-time",
                    nullable: true,
                    description: "Fecha en que se desactivará el servicio",
                  },
                },
              },
            },
          },
          400: { description: "Sin suscripción activa para cancelar", ...errorResponse },
          403: { description: "Solo el owner puede gestionar suscripciones", ...errorResponse },
        },
      },
      preHandler: [authHook, ownerOnly],
    },
    async (req, res) => {
      const user = req.user as JwtPayload;

      const sub = await prisma.subscription.findFirst({
        where: {
          tenant_id: user.tenantId,
          status: { in: ["active", "trialing"] },
        },
      });

      if (!sub?.stripe_subscription_id) {
        return res.code(400).send({
          success: false,
          error: {
            code: "BAD_req",
            message: "No hay suscripción activa para cancelar",
          },
        });
      }

      // Cancelar al final del período en Stripe (no de inmediato)
      await stripe.subscriptions.update(sub.stripe_subscription_id, {
        cancel_at_period_end: true,
      });

      await featureCache.del(user.tenantId);

      return res.send({
        success: true,
        data: {
          message: "Tu suscripción se cancelará al final del período actual",
          endsAt: sub.current_period_end,
        },
      });
    },
  );
}

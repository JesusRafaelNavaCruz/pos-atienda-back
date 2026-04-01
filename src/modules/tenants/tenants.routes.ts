// src/modules/tenants/subscriptions.routes.ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import Stripe from "stripe";
import prisma, { tenantStorage } from "../../lib/prisma.js";
import { featureCache } from "../../lib/redis.js";
import { env } from "../../config/env.js";
import type { JwtPayload } from "../../types/index.js";

const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

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
  app.get("/plans", async (req, res) => {
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
      // En producción, agrega el price_id real de Stripe Dashboard
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
                interval: plan.billing_interval as "month" | "year",
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

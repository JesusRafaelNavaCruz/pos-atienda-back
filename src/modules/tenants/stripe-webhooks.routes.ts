// src/modules/tenants/stripe-webhooks.routes.ts
// Maneja los eventos de Stripe para actualizar el estado de las suscripciones.
// Este endpoint NO usa JWT — usa firma HMAC de Stripe para autenticación.

import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { SubscriptionStatus } from "@prisma/client";
import prisma from "../../lib/prisma.js";
import { featureCache } from "../../lib/redis.js";
import { env } from "../../config/env.js";

const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

// Map de status de Stripe → status interno
const statusMap: Record<string, SubscriptionStatus> = {
  active: SubscriptionStatus.active,
  trialing: SubscriptionStatus.trialing,
  past_due: SubscriptionStatus.past_due,
  canceled: SubscriptionStatus.canceled,
  unpaid: SubscriptionStatus.unpaid,
  incomplete: SubscriptionStatus.past_due,
  incomplete_expired: SubscriptionStatus.canceled,
};

export async function stripeWebhooksRoutes(app: FastifyInstance) {
  // Stripe necesita el body crudo (sin parsear) para verificar la firma
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => done(null, body),
  );

  app.post("/stripe", async (request, reply) => {
    const sig = request.headers["stripe-signature"] as string;

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        request.body as Buffer,
        sig,
        env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err: any) {
      app.log.warn(`Webhook de Stripe inválido: ${err.message}`);
      return reply.code(400).send({ error: "Firma inválida" });
    }

    // Verificar idempotencia — ignorar eventos ya procesados
    const already = await prisma.billingEvent.findUnique({
      where: { stripe_event_id: event.id },
    });
    if (already) {
      return reply.send({ received: true });
    }

    // Procesar según tipo de evento
    try {
      switch (event.type) {
        case "customer.subscription.created":
        case "customer.subscription.updated": {
          const sub = event.data.object as Stripe.Subscription;
          const tenantId = sub.metadata?.tenant_id;

          if (!tenantId) {
            app.log.warn(`Suscripción ${sub.id} sin tenant_id en metadata`);
            break;
          }

          // Buscar el plan por price_id de Stripe
          const priceId = sub.items.data[0]?.price?.id;
          const plan = priceId
            ? await prisma.plan.findFirst({
                where: { code: sub.metadata?.plan_code },
              })
            : null;

          await prisma.subscription.upsert({
            where: { stripe_subscription_id: sub.id },
            create: {
              tenant_id: tenantId,
              plan_id:
                plan?.id ??
                (await prisma.plan.findFirst({ where: { code: "basic" } }))!.id,
              stripe_subscription_id: sub.id,
              stripe_customer_id: sub.customer as string,
              status: statusMap[sub.status] ?? SubscriptionStatus.active,
              current_period_start: new Date(sub.current_period_start * 1000),
              current_period_end: new Date(sub.current_period_end * 1000),
              trial_ends_at: sub.trial_end
                ? new Date(sub.trial_end * 1000)
                : null,
            },
            update: {
              status: statusMap[sub.status] ?? SubscriptionStatus.active,
              plan_id: plan?.id ?? undefined,
              current_period_start: new Date(sub.current_period_start * 1000),
              current_period_end: new Date(sub.current_period_end * 1000),
              trial_ends_at: sub.trial_end
                ? new Date(sub.trial_end * 1000)
                : null,
            },
          });

          // Invalidar caché de features del tenant
          await featureCache.del(tenantId);
          app.log.info(
            `Suscripción actualizada para tenant ${tenantId}: ${sub.status}`,
          );
          break;
        }

        case "customer.subscription.deleted": {
          const sub = event.data.object as Stripe.Subscription;
          const tenantId = sub.metadata?.tenant_id;

          if (tenantId) {
            await prisma.subscription.updateMany({
              where: { stripe_subscription_id: sub.id },
              data: {
                status: SubscriptionStatus.canceled,
                canceled_at: new Date(),
              },
            });
            await featureCache.del(tenantId);
            app.log.info(`Suscripción cancelada para tenant ${tenantId}`);
          }
          break;
        }

        case "invoice.payment_succeeded": {
          const invoice = event.data.object as Stripe.Invoice;
          const subId = invoice.subscription as string;

          if (subId) {
            await prisma.subscription.updateMany({
              where: { stripe_subscription_id: subId },
              data: { status: SubscriptionStatus.active },
            });

            const sub = await prisma.subscription.findFirst({
              where: { stripe_subscription_id: subId },
            });
            if (sub) await featureCache.del(sub.tenant_id);
          }
          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object as Stripe.Invoice;
          const subId = invoice.subscription as string;

          if (subId) {
            await prisma.subscription.updateMany({
              where: { stripe_subscription_id: subId },
              data: { status: SubscriptionStatus.past_due },
            });
            const sub = await prisma.subscription.findFirst({
              where: { stripe_subscription_id: subId },
            });
            if (sub) await featureCache.del(sub.tenant_id);
            app.log.warn(`Pago fallido para suscripción ${subId}`);
          }
          break;
        }

        default:
          app.log.info(`Evento de Stripe no manejado: ${event.type}`);
      }

      // Registrar el evento procesado
      await prisma.billingEvent.create({
        data: {
          stripe_event_id: event.id,
          event_type: event.type,
          payload: event as any,
        },
      });
    } catch (err: any) {
      app.log.error(`Error procesando webhook ${event.type}: ${err.message}`);
      return reply
        .code(500)
        .send({ error: "Error interno procesando el evento" });
    }

    return reply.send({ received: true });
  });
}

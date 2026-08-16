// src/modules/tenants/stripe-webhooks.routes.ts
// Maneja los eventos de Stripe para actualizar el estado de las suscripciones.
// Este endpoint NO usa JWT — usa firma HMAC de Stripe para autenticación.
import Stripe from "stripe";
import { SubscriptionStatus } from "@prisma/client";
import prisma from "../../lib/prisma.js";
import { featureCache } from "../../lib/redis.js";
import { env } from "../../config/env.js";
const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" });
// Map de status de Stripe → status interno
const statusMap = {
    active: SubscriptionStatus.active,
    trialing: SubscriptionStatus.trialing,
    past_due: SubscriptionStatus.past_due,
    canceled: SubscriptionStatus.canceled,
    unpaid: SubscriptionStatus.unpaid,
    incomplete: SubscriptionStatus.past_due,
    incomplete_expired: SubscriptionStatus.canceled,
};
export async function stripeWebhooksRoutes(app) {
    // Stripe requiere el body como Buffer para verificar la firma HMAC.
    // Eliminamos el parser JSON heredado del scope padre y registramos uno
    // que entrega el buffer crudo, evitando que Fastify v5 lo deserialice.
    app.removeContentTypeParser("application/json");
    app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    app.post("/stripe", async (request, reply) => {
        const sig = request.headers["stripe-signature"];
        if (!sig) {
            app.log.warn("[Stripe webhook] Header stripe-signature ausente");
            return reply.code(400).send({ error: "Header stripe-signature requerido" });
        }
        let event;
        try {
            event = stripe.webhooks.constructEvent(request.body, sig, env.STRIPE_WEBHOOK_SECRET);
        }
        catch (err) {
            app.log.warn(`[Stripe webhook] Firma inválida: ${err.message}`);
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
                    const sub = event.data.object;
                    const tenantId = sub.metadata?.tenant_id;
                    const planCode = sub.metadata?.plan_code;
                    app.log.info(`[Stripe webhook] ${event.type} | sub=${sub.id} | tenant=${tenantId} | plan=${planCode} | status=${sub.status}`);
                    if (!tenantId) {
                        app.log.warn(`[Stripe webhook] Suscripción ${sub.id} sin tenant_id en metadata — ignorado`);
                        break;
                    }
                    // Buscar el plan por plan_code guardado en la metadata de la suscripción
                    const plan = planCode
                        ? await prisma.plan.findFirst({ where: { code: planCode } })
                        : null;
                    if (!plan) {
                        app.log.warn(`[Stripe webhook] Plan "${planCode}" no encontrado en BD para sub=${sub.id}`);
                    }
                    // En API 2026-03-25.dahlia, current_period_start/end se leen desde el
                    // primer SubscriptionItem (se movieron de Subscription a SubscriptionItem).
                    const item = sub.items.data[0];
                    const periodStart = item?.current_period_start
                        ? new Date(item.current_period_start * 1000)
                        : new Date();
                    const periodEnd = item?.current_period_end
                        ? new Date(item.current_period_end * 1000)
                        : new Date();
                    await prisma.subscription.upsert({
                        where: { stripe_subscription_id: sub.id },
                        create: {
                            tenant_id: tenantId,
                            plan_id: plan?.id ??
                                (await prisma.plan.findFirst({ where: { code: "basic" } })).id,
                            stripe_subscription_id: sub.id,
                            stripe_customer_id: sub.customer,
                            status: statusMap[sub.status] ?? SubscriptionStatus.active,
                            current_period_start: periodStart,
                            current_period_end: periodEnd,
                            trial_ends_at: sub.trial_end
                                ? new Date(sub.trial_end * 1000)
                                : null,
                        },
                        update: {
                            status: statusMap[sub.status] ?? SubscriptionStatus.active,
                            plan_id: plan?.id ?? undefined,
                            current_period_start: periodStart,
                            current_period_end: periodEnd,
                            trial_ends_at: sub.trial_end
                                ? new Date(sub.trial_end * 1000)
                                : null,
                        },
                    });
                    // Invalidar caché de features del tenant
                    await featureCache.del(tenantId);
                    app.log.info(`Suscripción actualizada para tenant ${tenantId}: ${sub.status}`);
                    break;
                }
                case "customer.subscription.deleted": {
                    const sub = event.data.object;
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
                    const invoice = event.data.object;
                    // En API 2026-03-25.dahlia, invoice.subscription fue eliminado;
                    // el ID de suscripción está en invoice.parent.subscription_details.subscription
                    const subId = invoice.parent?.subscription_details?.subscription;
                    if (subId) {
                        await prisma.subscription.updateMany({
                            where: { stripe_subscription_id: subId },
                            data: { status: SubscriptionStatus.active },
                        });
                        const sub = await prisma.subscription.findFirst({
                            where: { stripe_subscription_id: subId },
                        });
                        if (sub)
                            await featureCache.del(sub.tenant_id);
                    }
                    break;
                }
                case "invoice.payment_failed": {
                    const invoice = event.data.object;
                    const subId = invoice.parent?.subscription_details?.subscription;
                    if (subId) {
                        await prisma.subscription.updateMany({
                            where: { stripe_subscription_id: subId },
                            data: { status: SubscriptionStatus.past_due },
                        });
                        const sub = await prisma.subscription.findFirst({
                            where: { stripe_subscription_id: subId },
                        });
                        if (sub)
                            await featureCache.del(sub.tenant_id);
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
                    payload: event,
                },
            });
        }
        catch (err) {
            app.log.error(`Error procesando webhook ${event.type}: ${err.message}`);
            return reply
                .code(500)
                .send({ error: "Error interno procesando el evento" });
        }
        return reply.send({ received: true });
    });
}
//# sourceMappingURL=stripe-webhooks.routes.js.map
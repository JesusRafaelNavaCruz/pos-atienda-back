import type { FastifyInstance } from 'fastify'
import { envMP } from '../../config/mercadopago.config.js'
import prisma, { tenantStorage } from '../../lib/prisma.js'
import { completeOAuthAuthorization, createOAuthAuthorization } from '../../lib/mercadopago/oauth.service.js'
import { requireFeature } from '../../middleware/authorize.js'
import type { JwtPayload } from '../../types/index.js'

const errorResponse = { type: 'object', properties: { success: { type: 'boolean' }, error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } } }
const authHook = async (req: any, reply: any) => { try { await req.jwtVerify() } catch { return reply.code(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Autenticación requerida' } }) } }
const ownerOnly = async (req: any, reply: any) => { if ((req.user as JwtPayload).roleCode !== 'owner') return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Solo el owner puede gestionar la conexión Mercado Pago' } }) }

export async function mercadoPagoOAuthRoutes(app: FastifyInstance) {
  const featureHook = requireFeature('card_payments')

  app.get('/connection', { schema: { tags: ['Mercado Pago'], summary: 'Estado de conexión OAuth', security: [{ bearerAuth: [] }], response: { 200: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', nullable: true } } } } }, preHandler: [authHook, featureHook, ownerOnly] }, async (req, reply) => {
    const user = req.user as JwtPayload
    const data = await tenantStorage.run(user.tenantId, () => prisma.mercadoPagoConnection.findFirst({ where: { tenant_id: user.tenantId }, select: { collector_id: true, is_active: true, token_expires_at: true, updated_at: true } }))
    return reply.send({ success: true, data })
  })

  app.get('/connect', { schema: { tags: ['Mercado Pago'], summary: 'Iniciar vinculación OAuth', description: 'Genera una URL de autorización OAuth con state de un solo uso y PKCE. El frontend debe redirigir el navegador a authorization_url.', security: [{ bearerAuth: [] }], response: { 200: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { authorization_url: { type: 'string', format: 'uri' } } } } }, 403: errorResponse } }, preHandler: [authHook, featureHook, ownerOnly] }, async (req, reply) => {
    const user = req.user as JwtPayload
    const authorization_url = await createOAuthAuthorization(user.tenantId, user.sub)
    return reply.send({ success: true, data: { authorization_url } })
  })

  app.delete('/connection', { schema: { tags: ['Mercado Pago'], summary: 'Desconectar cuenta Mercado Pago', description: 'Desactiva las credenciales locales y las terminales autorizadas. Debes cancelar cobros pendientes antes de desconectar.', security: [{ bearerAuth: [] }], response: { 200: { type: 'object', properties: { success: { type: 'boolean' } } }, 403: errorResponse } }, preHandler: [authHook, featureHook, ownerOnly] }, async (req, reply) => {
    const user = req.user as JwtPayload
    await tenantStorage.run(user.tenantId, () => prisma.$transaction([
      prisma.mercadoPagoConnection.updateMany({ where: { tenant_id: user.tenantId }, data: { is_active: false } }),
      prisma.mercadoPagoTerminal.updateMany({ where: { tenant_id: user.tenantId }, data: { is_active: false } }),
    ]))
    return reply.send({ success: true })
  })
}

export async function mercadoPagoOAuthCallbackRoutes(app: FastifyInstance) {
  app.get('/callback', { schema: { tags: ['Mercado Pago'], summary: 'Callback OAuth Mercado Pago', description: 'Endpoint público llamado por Mercado Pago tras el consentimiento. No debe llamarse desde el frontend.', querystring: { type: 'object', required: ['code', 'state'], properties: { code: { type: 'string' }, state: { type: 'string' } } }, response: { 302: { type: 'null' }, 400: errorResponse } } }, async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string }
    if (!code || !state) return reply.code(400).send({ success: false, error: { code: 'INVALID_OAUTH_CALLBACK', message: 'Faltan parámetros OAuth' } })
    try {
      await completeOAuthAuthorization(state, code)
      return reply.redirect(`${envMP.MP_OAUTH_SUCCESS_URL}${envMP.MP_OAUTH_SUCCESS_URL.includes('?') ? '&' : '?'}mercadopago=connected`)
    } catch {
      return reply.redirect(`${envMP.MP_OAUTH_SUCCESS_URL}${envMP.MP_OAUTH_SUCCESS_URL.includes('?') ? '&' : '?'}mercadopago=error`)
    }
  })
}

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { envMP } from '../../config/mercadopago.config.js'
import prisma, { tenantStorage } from '../prisma.js'

type OAuthToken = { access_token: string; refresh_token: string; user_id: string | number; expires_in?: number }

function encryptionKey() {
  const key = Buffer.from(envMP.MP_TOKEN_ENCRYPTION_KEY, 'base64url')
  if (key.length !== 32) throw new Error('MP_TOKEN_ENCRYPTION_KEY debe ser una clave base64url de 32 bytes')
  return key
}

export function encryptMPSecret(value: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`
}

export function decryptMPSecret(value: string) {
  const [ivEncoded, tagEncoded, encrypted] = value.split('.')
  if (!ivEncoded || !tagEncoded || !encrypted) throw new Error('Credencial Mercado Pago cifrada inválida')
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivEncoded, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8')
}

function sha256(value: string) { return createHash('sha256').update(value).digest('hex') }
function verifier() { return randomBytes(48).toString('base64url') }
function challenge(value: string) { return createHash('sha256').update(value).digest('base64url') }

async function tokenRequest(body: Record<string, string>): Promise<OAuthToken> {
  const response = await fetch(`${envMP.MP_API_URL}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ client_id: envMP.MP_CLIENT_ID, client_secret: envMP.MP_CLIENT_SECRET, ...body }) })
  if (!response.ok) throw new Error('No fue posible autorizar la cuenta Mercado Pago')
  return response.json() as Promise<OAuthToken>
}

export async function createOAuthAuthorization(tenantId: string, userId: string) {
  const state = randomBytes(32).toString('base64url')
  const codeVerifier = verifier()
  await tenantStorage.run(tenantId, () => prisma.mercadoPagoOAuthState.create({ data: { tenant_id: tenantId, user_id: userId, state_hash: sha256(state), code_verifier_encrypted: encryptMPSecret(codeVerifier), expires_at: new Date(Date.now() + 10 * 60 * 1000) } }))
  const url = new URL('https://auth.mercadopago.com/authorization')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', envMP.MP_CLIENT_ID)
  url.searchParams.set('redirect_uri', envMP.MP_OAUTH_REDIRECT_URI)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge(codeVerifier))
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('scope', 'offline_access')
  return url.toString()
}

export async function completeOAuthAuthorization(state: string, code: string) {
  const attempt = await prisma.mercadoPagoOAuthState.findUnique({ where: { state_hash: sha256(state) } })
  if (!attempt || attempt.consumed_at || attempt.expires_at < new Date()) throw new Error('La autorización expiró o ya fue utilizada')
  await tenantStorage.run(attempt.tenant_id, () => prisma.mercadoPagoOAuthState.update({ where: { id: attempt.id }, data: { consumed_at: new Date() } }))
  const token = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: envMP.MP_OAUTH_REDIRECT_URI, code_verifier: decryptMPSecret(attempt.code_verifier_encrypted), test_token: String(envMP.MP_OAUTH_TEST_MODE) })
  const expiresAt = new Date(Date.now() + Math.max((token.expires_in ?? 0) - 300, 60) * 1000)
  await tenantStorage.run(attempt.tenant_id, () => prisma.mercadoPagoConnection.upsert({ where: { tenant_id: attempt.tenant_id }, create: { tenant_id: attempt.tenant_id, collector_id: String(token.user_id), access_token_encrypted: encryptMPSecret(token.access_token), refresh_token_encrypted: encryptMPSecret(token.refresh_token), token_expires_at: expiresAt, is_active: true }, update: { collector_id: String(token.user_id), access_token_encrypted: encryptMPSecret(token.access_token), refresh_token_encrypted: encryptMPSecret(token.refresh_token), token_expires_at: expiresAt, is_active: true } }))
  return attempt.tenant_id
}

export async function getTenantMPAccessToken(tenantId: string) {
  const connection = await tenantStorage.run(tenantId, () => prisma.mercadoPagoConnection.findFirst({ where: { tenant_id: tenantId, is_active: true } }))
  if (!connection) throw new Error('MERCADOPAGO_NOT_CONNECTED')
  if (connection.token_expires_at > new Date()) return decryptMPSecret(connection.access_token_encrypted)
  const token = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decryptMPSecret(connection.refresh_token_encrypted) })
  const expiresAt = new Date(Date.now() + Math.max((token.expires_in ?? 0) - 300, 60) * 1000)
  await tenantStorage.run(tenantId, () => prisma.mercadoPagoConnection.update({ where: { tenant_id: tenantId }, data: { access_token_encrypted: encryptMPSecret(token.access_token), refresh_token_encrypted: encryptMPSecret(token.refresh_token), token_expires_at: expiresAt } }))
  return token.access_token
}

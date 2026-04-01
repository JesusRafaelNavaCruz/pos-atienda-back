// src/lib/redis.ts
import Redis from 'ioredis'
import { env } from '../config/env.js'

let redisInstance: Redis | null = null
let redisAvailable = true  // flag para evitar reintentos en cascada

export function getRedis(): Redis | null {

  if (!redisAvailable) return null;

  if (!redisInstance) {
    redisInstance = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (times) => {
        if (times > 2) {
          redisAvailable = false      // marcar como no disponible
          console.warn('[Redis] No disponible, operando sin caché')
          return null                 // dejar de reintentar
        }
        return Math.min(times * 200, 1000)
      },
    })

    redisInstance.on('error', (err) => {
      console.error('[Redis] Error de conexión:', err.message)
      redisAvailable = false
    })

    redisInstance.on('connect', () => {
      redisAvailable = true
      console.log('[Redis] Conectado')
    })

    redisInstance.on('reconnecting', () => {
      redisAvailable = true          // intentando reconectar
    })
  }
  return redisInstance
}

// Helpers tipados para caché de features
export const featureCache = {
  key: (tenantId: string) => `features:${tenantId}`,

  async get(tenantId: string): Promise<Record<string, string> | null> {
    const redis = getRedis()
    if (!redis) return null           // sin Redis → miss de caché, va a BD
    try {
      const raw = await redis.get(featureCache.key(tenantId))
      return raw ? JSON.parse(raw) : null
    } catch {
      return null                     // error puntual → miss de caché
    }
  },

  async set(tenantId: string, features: Record<string, string>, ttl: number): Promise<void> {
    const redis = getRedis()
    if (!redis) return                // sin Redis → simplemente no cachear
    try {
      await redis.setex(featureCache.key(tenantId), ttl, JSON.stringify(features))
    } catch {
      // silencioso — no cachear no es un error fatal
    }
  },

  async del(tenantId: string): Promise<void> {
    const redis = getRedis()
    if (!redis) return
    try {
      await redis.del(featureCache.key(tenantId))
    } catch {}
  },
}

export default getRedis

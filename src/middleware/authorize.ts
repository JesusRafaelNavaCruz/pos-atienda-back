import { env } from "@/config/env";
import prisma from "@/lib/prisma";
import { featureCache } from "@/lib/redis";
import type { AdminJwtPayload, FeatureKey, JwtPayload } from "@/types";
import { FastifyReply, FastifyRequest } from "fastify";

export function requireFeature(featureKey: FeatureKey) {
  return async (req: FastifyRequest, res: FastifyReply) => {
    const user = req.user as JwtPayload;
    const tenantId = user.tenantId;

    // prioriza intentar desde cache
    let features = await featureCache.get(tenantId);

    if (!features) {
      // Consultar en BD: features del plan activo
      const subscription = await prisma.subscription.findFirst({
        where: {
          tenant_id: tenantId,
          status: {
            in: ["active", "trialing"],
          },
        },
        orderBy: { created_at: "desc" }, // la suscripción más reciente (plan upgrade)
        include: {
          plan: {
            include: {
              features: true,
            },
          },
        },
      });

      if (!subscription) {
        return res.code(403).send({
          success: false,
          error: {
            code: "SUBSCRIPTION_REQUIRED",
            message: "No tienes una suscripción activa",
          },
        });
      }

      features = Object.fromEntries(
        subscription.plan.features.map((f) => [f.feature_key, f.limit_value]),
      );

      await featureCache.set(tenantId, features, env.FEATURE_CACHE_TTL);
    }

    const value = features[featureKey];
    const isEnabled = value && value !== "false" && value !== "0";

    if (!isEnabled) {
      return res.code(403).send({
        success: false,
        error: {
          code: "FEATURE_NOT_AVAILABLE",
          message: `La función ${featureKey} no está disponible en tu plan actual. Considera actualizar tu suscripción`,
        },
      });
    }
  };
}

export function requirePermission(resource: string, action: string) {

  return async (req: FastifyRequest, res: FastifyReply) => {
    const user = req.user as JwtPayload

    if (user.roleCode === 'owner') return

    const role = await prisma.role.findFirst({
      where: {
        tenant_id: user.tenantId,
        code: user.roleCode,
      },
      include: {
        permissions: {
          include: {
            permission: true,
          }
        }
      }
    })

    if (!role) {
      return res.code(403).send({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Rol no encontrado',
        },
      })
    }

    const hasPermission = role.permissions.some(
      (rp) => rp.permission.resource === resource && rp.permission.action === action
    )

    if (!hasPermission) {
      return res.code(403).send({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: `No tienes permiso para ${action} en ${resource}`,
        },
      })
    }

  }

}

export function requireSuperAdmin() {
  return async (req: FastifyRequest, res: FastifyReply) => {
    const user = req.user as AdminJwtPayload
    if (!user?.isSuperAdmin) {
      return res.code(403).send({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Acceso restringido a super administradores',
        },
      })
    }
  }
}

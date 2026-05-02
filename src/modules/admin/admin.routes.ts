import prisma, { tenantStorage } from "@/lib/prisma";
import { requireSuperAdmin } from "@/middleware/authorize";
import type { AdminJwtPayload, JwtPayload } from "@/types";
import { FastifyInstance } from "fastify";
import { z } from "zod";

const authHook = async (req: any, rep: any) => {
  try {
    await req.jwtVerify();
  } catch {
    return rep.code(401).send();
  }
};

const errorSchema = {
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
} as const;

export async function adminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authHook);
  app.addHook("preHandler", requireSuperAdmin());

  // GET /admin/tenants — listar todos los tenants
  app.get(
    "/tenants",
    {
      schema: {
        tags: ["Admin"],
        summary: "Listar todos los tenants",
        security: [{ bearerAuth: [] }],
        querystring: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["active", "suspended", "canceled", "trial"] },
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  tenants: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        slug: { type: "string" },
                        status: { type: "string" },
                        createdAt: { type: "string" },
                        subscription: {
                          type: "object",
                          nullable: true,
                          properties: {
                            status: { type: "string" },
                            planName: { type: "string" },
                            trialEndsAt: { type: "string", nullable: true },
                            currentPeriodEnd: { type: "string", nullable: true },
                          },
                        },
                      },
                    },
                  },
                  total: { type: "integer" },
                  page: { type: "integer" },
                  limit: { type: "integer" },
                },
              },
            },
          },
        },
      },
    },
    async (req, res) => {
      const { status, page = 1, limit = 20 } = req.query as {
        status?: string;
        page?: number;
        limit?: number;
      };

      const where = status ? { status: status as any } : {};

      const [tenants, total] = await Promise.all([
        prisma.tenant.findMany({
          where,
          skip: (page - 1) * limit,
          take: limit,
          orderBy: { created_at: "desc" },
          include: {
            subscriptions: {
              orderBy: { created_at: "desc" },
              take: 1,
              include: { plan: { select: { name: true } } },
            },
          },
        }),
        prisma.tenant.count({ where }),
      ]);

      return res.send({
        success: true,
        data: {
          tenants: tenants.map((t) => {
            const sub = t.subscriptions[0] ?? null;
            return {
              id: t.id,
              name: t.name,
              slug: t.slug,
              status: t.status,
              createdAt: t.created_at,
              subscription: sub
                ? {
                    status: sub.status,
                    planName: sub.plan.name,
                    trialEndsAt: sub.trial_ends_at,
                    currentPeriodEnd: sub.current_period_end,
                  }
                : null,
            };
          }),
          total,
          page,
          limit,
        },
      });
    },
  );

  // GET /admin/tenants/:id — detalle de un tenant
  app.get(
    "/tenants/:id",
    {
      schema: {
        tags: ["Admin"],
        summary: "Detalle de un tenant",
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: { type: "object", additionalProperties: true },
            },
          },
          404: errorSchema,
        },
      },
    },
    async (req, res) => {
      const { id } = req.params as { id: string };

      const tenant = await prisma.tenant.findUnique({
        where: { id },
        include: {
          subscriptions: {
            orderBy: { created_at: "desc" },
            take: 1,
            include: { plan: { include: { features: true } } },
          },
        },
      });

      if (!tenant) {
        return res.code(404).send({
          success: false,
          error: { code: "NOT_FOUND", message: "Tenant no encontrado" },
        });
      }

      const [userCount, branchCount] = await tenantStorage.run(id, () =>
        Promise.all([
          prisma.user.count({ where: { tenant_id: id, is_active: true } }),
          prisma.branch.count({ where: { tenant_id: id, is_active: true } }),
        ]),
      );

      const sub = tenant.subscriptions[0] ?? null;

      return res.send({
        success: true,
        data: {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          status: tenant.status,
          timezone: tenant.timezone,
          country: tenant.country,
          createdAt: tenant.created_at,
          usage: { users: userCount, branches: branchCount },
          subscription: sub
            ? {
                id: sub.id,
                status: sub.status,
                planName: sub.plan.name,
                planCode: sub.plan.code,
                priceMxn: Number(sub.plan.price_mxn),
                maxUsers: sub.plan.max_users,
                maxBranches: sub.plan.max_branches,
                trialEndsAt: sub.trial_ends_at,
                currentPeriodEnd: sub.current_period_end,
                canceledAt: sub.canceled_at,
                features: Object.fromEntries(
                  sub.plan.features.map((f) => [f.feature_key, f.limit_value]),
                ),
              }
            : null,
        },
      });
    },
  );

  // PATCH /admin/tenants/:id/status — suspender o reactivar tenant
  app.patch(
    "/tenants/:id/status",
    {
      schema: {
        tags: ["Admin"],
        summary: "Cambiar estado de un tenant",
        description: "Permite suspender o reactivar un tenant.",
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["status"],
          properties: {
            status: { type: "string", enum: ["active", "suspended"] },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  status: { type: "string" },
                },
              },
            },
          },
          404: errorSchema,
        },
      },
    },
    async (req, res) => {
      const { id } = req.params as { id: string };
      const { status } = z
        .object({ status: z.enum(["active", "suspended"]) })
        .parse(req.body);

      const tenant = await prisma.tenant.findUnique({ where: { id } });
      if (!tenant) {
        return res.code(404).send({
          success: false,
          error: { code: "NOT_FOUND", message: "Tenant no encontrado" },
        });
      }

      const updated = await prisma.tenant.update({
        where: { id },
        data: { status },
      });

      return res.send({
        success: true,
        data: { id: updated.id, status: updated.status },
      });
    },
  );

  // GET /admin/tenants/:tenantId/users — listar usuarios de un tenant
  app.get(
    "/tenants/:tenantId/users",
    {
      schema: {
        tags: ["Admin"],
        summary: "Listar usuarios de un tenant",
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["tenantId"],
          properties: { tenantId: { type: "string", format: "uuid" } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    email: { type: "string" },
                    fullName: { type: "string" },
                    role: { type: "string" },
                    roleCode: { type: "string" },
                    isActive: { type: "boolean" },
                    lastLoginAt: { type: "string", nullable: true },
                  },
                },
              },
            },
          },
          404: errorSchema,
        },
      },
    },
    async (req, res) => {
      const { tenantId } = req.params as { tenantId: string };

      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) {
        return res.code(404).send({
          success: false,
          error: { code: "NOT_FOUND", message: "Tenant no encontrado" },
        });
      }

      const users = await tenantStorage.run(tenantId, () =>
        prisma.user.findMany({
          where: { tenant_id: tenantId },
          include: { role: { select: { name: true, code: true } } },
          orderBy: { created_at: "asc" },
        }),
      );

      return res.send({
        success: true,
        data: users.map((u) => ({
          id: u.id,
          email: u.email,
          fullName: u.full_name,
          role: u.role.name,
          roleCode: u.role.code,
          isActive: u.is_active,
          lastLoginAt: u.last_login_at,
        })),
      });
    },
  );

  // POST /admin/impersonate/:tenantId — generar token de impersonación
  app.post(
    "/impersonate/:tenantId",
    {
      schema: {
        tags: ["Admin"],
        summary: "Impersonar owner de un tenant",
        description:
          "Genera un access token de 1 hora que actúa como el owner del tenant. Útil para soporte técnico. No genera refresh token.",
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["tenantId"],
          properties: { tenantId: { type: "string", format: "uuid" } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  accessToken: { type: "string" },
                  expiresIn: { type: "string" },
                  tenant: { type: "string" },
                  impersonating: { type: "string" },
                },
              },
            },
          },
          404: errorSchema,
        },
      },
    },
    async (req, res) => {
      const { tenantId } = req.params as { tenantId: string };
      const admin = req.user as AdminJwtPayload;

      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) {
        return res.code(404).send({
          success: false,
          error: { code: "NOT_FOUND", message: "Tenant no encontrado" },
        });
      }

      const ownerUser = await tenantStorage.run(tenantId, () =>
        prisma.user.findFirst({
          where: {
            tenant_id: tenantId,
            is_active: true,
            role: { code: "owner" },
          },
          include: { role: true },
        }),
      );

      if (!ownerUser) {
        return res.code(404).send({
          success: false,
          error: { code: "NOT_FOUND", message: "Owner del tenant no encontrado" },
        });
      }

      // Payload idéntico a un login real + marca de auditoría que identifica al admin
      const impersonationPayload: Omit<JwtPayload, "iat" | "exp"> & { impersonatedBy: string } = {
        sub: ownerUser.id,
        tenantId,
        roleCode: ownerUser.role.code,
        branchId: ownerUser.branch_id,
        email: ownerUser.email,
        impersonatedBy: admin.sub,
      };

      const accessToken = app.jwt.sign(impersonationPayload, { expiresIn: "1h" });

      return res.send({
        success: true,
        data: {
          accessToken,
          expiresIn: "1h",
          tenant: tenant.slug,
          impersonating: ownerUser.email,
        },
      });
    },
  );
}

import { env } from "@/config/env";
import prisma, { tenantStorage } from "@/lib/prisma";
import { JwtPayload, RefreshTokenPayload } from "@/types";
import { FastifyInstance } from "fastify";
import z, { success } from "zod";
import bcrypt from "bcryptjs";

// Schemas de validación
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  tenantSlug: z.string().min(1),
});

const registerSchema = z.object({
  tenantName: z.string().min(2).max(50),
  tenantSlug: z
    .string()
    .min(2)
    .max(55)
    .regex(/^[a-z0-9-]+$/, "Solo minúsculas, números y guiones"),
  ownerName: z.string().min(2).max(150),
  ownerEmail: z.string().email(),
  ownerPassword: z.string().min(8),
  planCode: z.enum(["basic", "pro", "enterprise"]).default("basic"),
});

const refreshSchema = z.object({
  refreshToken: z.string(),
});

const pinLoginSchema = z.object({
  pin: z
    .string()
    .length(4)
    .regex(/^\d{4}$/),
  tenantSlug: z
    .string()
    .min(2)
    .max(55)
    .regex(/^[a-z0-9-]+$/, "Solo minúsculas, números y guiones"),
});

// Helpers
function signTokens(
  app: FastifyInstance,
  payload: Omit<JwtPayload, "iat" | "exp">,
) {
  const accessToken = app.jwt.sign(payload, { expiresIn: env.JWT_EXPIRES_IN });
  const refreshPayload: RefreshTokenPayload = {
    sub: crypto.randomUUID(),
    userId: payload.sub,
    tenantId: payload.tenantId,
  };
  const refreshToken = app.jwt.sign(refreshPayload, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN,
  });
  return { accessToken, refreshToken, refreshPayload };
}

// Rutas
export async function authRoutes(app: FastifyInstance) {
  // POST /auth/register
  app.post(
    "/register",
    {
      schema: {
        tags: ["Auth"],
        summary: "Registrar nuevo tenant",
        description:
          "Crea un nuevo tenant junto con su usuario owner. No requiere autenticación.",
        security: [],
        body: {
          type: "object",
          required: [
            "tenantName",
            "tenantSlug",
            "ownerName",
            "ownerEmail",
            "ownerPassword",
          ],
          properties: {
            tenantName: { type: "string", minLength: 2, maxLength: 50 },
            tenantSlug: {
              type: "string",
              minLength: 2,
              maxLength: 55,
              description: "Solo minúsculas, números y guiones",
            },
            ownerName: { type: "string", minLength: 2, maxLength: 150 },
            ownerEmail: { type: "string", format: "email" },
            ownerPassword: { type: "string", minLength: 8 },
            planCode: {
              type: "string",
              enum: ["basic", "pro", "enterprise"],
              default: "basic",
            },
          },
        },
        response: {
          201: {
            description: "Tenant creado exitosamente",
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  tenant_id: { type: "string" },
                  userId: { type: "string" },
                  message: { type: "string" },
                },
              },
            },
          },
          409: {
            description: "El slug ya está en uso",
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
          },
        },
      },
    },
    async (req, res) => {
      const body = registerSchema.parse(req.body);

      // Verificar slug disponible
      const existing = await prisma.tenant.findUnique({
        where: { slug: body.tenantSlug },
      });
      if (existing) {
        return res.code(409).send({
          success: false,
          error: {
            code: "CONFLICT",
            message: "El slug ya está en uso",
          },
        });
      }

      const passwordHash = await bcrypt.hash(
        body.ownerPassword,
        env.BCRYPT_ROUNDS,
      );

      // Llamar a la función SQL de onboarding
      const result = await prisma.$queryRaw<
        Array<{ tenant_id: string; owner_user_id: string }>
      >`
        SELECT * FROM plataforma.onboard_tenant(
            ${body.tenantName},
            ${body.tenantSlug},
            ${body.ownerEmail},
            ${body.ownerName},
            ${passwordHash},
            ${body.planCode}
        )
    `;

      const { tenant_id, owner_user_id } = result[0];

      return res.code(201).send({
        success: true,
        data: {
          tenant_id: tenant_id,
          userId: owner_user_id,
          message: "Tenant creado. Ahora puedes iniciar sesión",
        },
      });
    },
  );

  // POST /auth/login
  app.post(
    "/login",
    {
      schema: {
        tags: ["Auth"],
        summary: "Iniciar sesión",
        description:
          "Autentica al usuario con email, contraseña y slug del tenant. Retorna access token y refresh token.",
        security: [],
        body: {
          type: "object",
          required: ["email", "password", "tenantSlug"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string", minLength: 8 },
            tenantSlug: { type: "string" },
          },
        },
        response: {
          200: {
            description: "Login exitoso",
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  accessToken: { type: "string" },
                  refreshToken: { type: "string" },
                  user: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      email: { type: "string" },
                      fullName: { type: "string" },
                      role: { type: "string", description: "Código del rol (owner, manager, cashier)" },
                      roleName: { type: "string", description: "Nombre del rol" },
                      permissions: {
                        type: "array",
                        items: { type: "string" },
                        description: "Lista de permisos en formato resource:action",
                      },
                      branchId: { type: "string", nullable: true },
                      tenant: { type: "string" },
                      tenantName: { type: "string" },
                      tenantSlug: { type: "string" },
                    },
                  },
                },
              },
            },
          },
          401: {
            description: "Credenciales inválidas",
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
          },
        },
      },
    },
    async (req, res) => {
      const body = loginSchema.parse(req.body);

      // Buscar por tenant id
      const tenant = await prisma.tenant.findUnique({
        where: { slug: body.tenantSlug },
        include: {
          subscriptions: {
            where: { status: { in: ["active", "trialing"] } },
            take: 1,
          },
        },
      });

      if (!tenant || tenant.status === "canceled") {
        return res.code(401).send({
          success: false,
          error: { code: "UNAUTHORIZED", message: "Credenciales ínvalidas" },
        });
      }

      // Buscar usuario - dentro del contexto tenant para RSL
      const user = await tenantStorage.run(tenant.id, () =>
        prisma.user.findFirst({
          where: {
            tenant_id: tenant.id,
            email: body.email,
            is_active: true,
          },
          include: {
            role: {
              include: { permissions: { include: { permission: true } } },
            },
          },
        }),
      );

      if (!user) {
        return res.code(401).send({
          success: false,
          error: { code: "UNAUTHORIZED", message: "Credenciales inválidas" },
        });
      }

      const passwordValid = await bcrypt.compare(
        body.password,
        user.password_hash,
      );
      if (!passwordValid) {
        return res.code(401).send({
          success: false,
          error: { code: "UNAUTHORIZED", message: "Credenciales inválidas" },
        });
      }

      const jwtPayload: Omit<JwtPayload, "iat" | "exp"> = {
        sub: user.id,
        tenantId: tenant.id,
        roleCode: user.role.code,
        branchId: user.branch_id,
        email: user.email,
      };

      const { accessToken, refreshToken, refreshPayload } = signTokens(
        app,
        jwtPayload,
      );

      // Guardar sesión
      const tokenHash = await bcrypt.hash(refreshToken, 10);
      await tenantStorage.run(tenant.id, () =>
        prisma.userSession.create({
          data: {
            id: refreshPayload.sub,
            user_id: user.id,
            tenant_id: tenant.id,
            refresh_token_hash: tokenHash,
            ip_address: req.ip,
            user_agent: req.headers["user-agent"] ?? null,
            expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          },
        }),
      );

      // Actualizar last_login_At
      await tenantStorage.run(tenant.id, () =>
        prisma.user.update({
          where: { id: user.id },
          data: { last_login_at: new Date() },
        }),
      );

      const permissions = user.role.permissions.map(
        (rp) => `${rp.permission.resource}:${rp.permission.action}`,
      );

      return res.send({
        success: true,
        data: {
          accessToken,
          refreshToken,
          user: {
            id: user.id,
            email: user.email,
            fullName: user.full_name,
            role: user.role.code,
            roleName: user.role.name,
            permissions,
            branchId: user.branch_id,
            tenant: tenant.id,
            tenantName: tenant.name,
            tenantSlug: tenant.slug,
          },
        },
      });
    },
  );

  // POST /auth/refresh
  app.post(
    "/refresh",
    {
      schema: {
        tags: ["Auth"],
        summary: "Renovar access token",
        description:
          "Genera un nuevo access token usando un refresh token válido.",
        security: [],
        body: {
          type: "object",
          required: ["refreshToken"],
          properties: {
            refreshToken: { type: "string" },
          },
        },
        response: {
          200: {
            description: "Token renovado exitosamente",
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  accessToken: { type: "string" },
                },
              },
            },
          },
          401: {
            description: "Refresh token inválido o sesión expirada",
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
          },
        },
      },
    },
    async (req, res) => {
      const { refreshToken } = refreshSchema.parse(req.body);

      let decoded: RefreshTokenPayload;
      try {
        decoded = app.jwt.verify(refreshToken) as RefreshTokenPayload;
      } catch {
        return res.code(401).send({
          success: false,
          error: { code: "UNAUTHORIZED", message: "Refresh token inválido" },
        });
      }

      const session = await tenantStorage.run(decoded.tenantId, () =>
        prisma.userSession.findFirst({
          where: {
            id: decoded.sub,
            user_id: decoded.userId,
            tenant_id: decoded.tenantId,
            expires_at: { gt: new Date() },
          },
          include: {
            user: { include: { role: true } },
          },
        }),
      );

      if (!session) {
        return res.code(401).send({
          success: false,
          error: { code: "UNAUTHORIZED", message: "Sesión inválida o expirada" },
        });
      }

      const valid = await bcrypt.compare(
        refreshToken,
        session.refresh_token_hash,
      );
      if (!valid) {
        return res.code(401).send({
          success: false,
          error: { code: "UNAUTHORIZED", message: "Refresh token inválido" },
        });
      }

      const jwtPayload: Omit<JwtPayload, "iat" | "exp"> = {
        sub: session.user.id,
        tenantId: decoded.tenantId,
        roleCode: session.user.role.code,
        branchId: session.user.branch_id,
        email: session.user.email,
      };

      const newAccessToken = app.jwt.sign(jwtPayload, {
        expiresIn: env.JWT_EXPIRES_IN,
      });

      return res.send({
        success: true,
        data: { accessToken: newAccessToken },
      });
    },
  );

  // POST /auth/logout
  app.post(
    "/logout",
    {
      schema: {
        tags: ["Auth"],
        summary: "Cerrar sesión",
        description: "Invalida todas las sesiones activas del usuario.",
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["refreshToken"],
          properties: {
            refreshToken: { type: "string" },
          },
        },
        response: {
          200: {
            description: "Sesión cerrada",
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  message: { type: "string" },
                },
              },
            },
          },
        },
      },
      preHandler: [
        async (req, rep) => {
          try {
            await req.jwtVerify();
          } catch {
            return rep.code(200).send();
          }
        },
      ],
    },
    async (req, res) => {
      const { refreshToken } = refreshSchema.parse(req.body);
      const user = req.user as JwtPayload;

      await tenantStorage.run(user.tenantId, () =>
        prisma.userSession.deleteMany({
          where: { user_id: user.sub, tenant_id: user.tenantId },
        }),
      );

      return res.send({ success: true, data: { message: "Sesión cerrada" } });
    },
  );

  // POST /auth/pin
  app.post(
    "/pin",
    {
      schema: {
        tags: ["Auth"],
        summary: "Login rápido por PIN",
        description:
          "Autentica a un usuario mediante su PIN de 4 dígitos. Retorna solo un access token de corta duración (8h).",
        security: [],
        body: {
          type: "object",
          required: ["pin", "tenantSlug"],
          properties: {
            pin: {
              type: "string",
              minLength: 4,
              maxLength: 4,
              description: "PIN numérico de 4 dígitos",
            },
            tenantSlug: { type: "string" },
          },
        },
        response: {
          200: {
            description: "Login por PIN exitoso",
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  accessToken: { type: "string" },
                  user: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      fullName: { type: "string" },
                      role: { type: "string" },
                    },
                  },
                },
              },
            },
          },
          401: {
            description: "PIN incorrecto o tenant no encontrado",
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
          },
        },
      },
    },
    async (req, res) => {
      const { pin, tenantSlug } = pinLoginSchema.parse(req.body);

      const tenant = await prisma.tenant.findUnique({
        where: { slug: tenantSlug },
      });
      if (!tenant) {
        return res.code(401).send({
          success: false,
          error: { code: "UNAUTHORIZED", message: "Tenant no encontrado" },
        });
      }

      const users = await tenantStorage.run(tenant.id, () =>
        prisma.user.findMany({
          where: {
            tenant_id: tenant.id,
            is_active: true,
            pin_hash: { not: null },
          },
          include: { role: true },
        }),
      );

      let matchedUser = null;
      for (const u of users) {
        if (u.pin_hash && (await bcrypt.compare(pin, u.pin_hash))) {
          matchedUser = u;
          break;
        }
      }

      if (!matchedUser) {
        return res.code(401).send({
          success: false,
          error: { code: "UNAUTHORIZED", message: "PIN incorrecto" },
        });
      }

      const jwtPayload: Omit<JwtPayload, "iat" | "exp"> = {
        sub: matchedUser.id,
        tenantId: tenant.id,
        roleCode: matchedUser.role.code,
        branchId: matchedUser.branch_id,
        email: matchedUser.email,
      };

      const accessToken = app.jwt.sign(jwtPayload, { expiresIn: "8h" });

      return res.send({
        success: true,
        data: {
          accessToken,
          user: {
            id: matchedUser.id,
            fullName: matchedUser.full_name,
            role: matchedUser.role.code,
          },
        },
      });
    },
  );

  // GET /auth/profile
  app.get(
    "/profile",
    {
      schema: {
        tags: ["Auth"],
        summary: "Obtener perfil del usuario autenticado",
        description:
          "Retorna los datos del usuario autenticado, incluyendo su rol y permisos.",
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            description: "Perfil del usuario",
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  email: { type: "string" },
                  fullName: { type: "string" },
                  role: { type: "string" },
                  roleName: { type: "string" },
                  permissions: {
                    type: "array",
                    items: { type: "string" },
                    description: "Lista de permisos en formato resource:action",
                  },
                  branch: { type: "object", nullable: true },
                  tenantId: { type: "string" },
                },
              },
            },
          },
          401: {
            description: "No autenticado o usuario no encontrado",
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
          },
        },
      },
      preHandler: [
        async (req, rep) => {
          try {
            await req.jwtVerify();
          } catch {
            return rep.code(401).send();
          }
        },
      ],
    },
    async (req, res) => {
      const jwtUser = req.user as JwtPayload;

      const user = await tenantStorage.run(jwtUser.tenantId, () =>
        prisma.user.findUnique({
          where: { id: jwtUser.sub },
          include: {
            role: {
              include: {
                permissions: { include: { permission: true } },
              },
            },
            branch: true,
          },
        }),
      );

      if (!user) {
        return res
          .code(401)
          .send({
            success: false,
            error: { code: "NOT_FOUND", message: "Usuario no encontrado" },
          });
      }

      const permissions = user.role.permissions.map(
        (rp) => `${rp.permission.resource}:${rp.permission.action}`,
      );

      return res.send({
        success: true,
        data: {
          id: user.id,
          email: user.email,
          fullName: user.full_name,
          role: user.role.name,
          roleName: user.role.name,
          permissions,
          branch: user.branch,
          tenantId: jwtUser.tenantId,
        },
      });
    },
  );
}

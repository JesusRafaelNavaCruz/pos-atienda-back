import { env } from "@/config/env";
import prisma from "@/lib/prisma";
import type { AdminJwtPayload, AdminRefreshTokenPayload } from "@/types";
import bcrypt from "bcryptjs";
import { FastifyInstance } from "fastify";
import { z } from "zod";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const refreshSchema = z.object({
  refreshToken: z.string(),
});

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

function signAdminTokens(app: FastifyInstance, adminUser: { id: string; email: string; full_name: string }) {
  const payload: Omit<AdminJwtPayload, "iat" | "exp"> = {
    sub: adminUser.id,
    email: adminUser.email,
    fullName: adminUser.full_name,
    isSuperAdmin: true,
  };

  const accessToken = app.jwt.sign(payload, { expiresIn: env.JWT_EXPIRES_IN });

  const refreshPayload: AdminRefreshTokenPayload = {
    sub: crypto.randomUUID(),
    adminId: adminUser.id,
  };
  const refreshToken = app.jwt.sign(refreshPayload, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN,
  });

  return { accessToken, refreshToken, refreshPayload };
}

export async function adminAuthRoutes(app: FastifyInstance) {
  // POST /admin/auth/login
  app.post(
    "/login",
    {
      schema: {
        tags: ["Admin Auth"],
        summary: "Login de super administrador",
        description: "Autentica al super administrador. No requiere tenantSlug.",
        security: [],
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string", minLength: 8 },
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
                  accessToken: { type: "string" },
                  refreshToken: { type: "string" },
                  admin: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      email: { type: "string" },
                      fullName: { type: "string" },
                    },
                  },
                },
              },
            },
          },
          401: errorSchema,
        },
      },
    },
    async (req, res) => {
      const { email, password } = loginSchema.parse(req.body);

      const admin = await prisma.adminUser.findUnique({
        where: { email, is_active: true },
      });

      if (!admin) {
        return res.code(401).send({
          success: false,
          error: { code: "UNAUTHORIZED", message: "Credenciales inválidas" },
        });
      }

      const passwordValid = await bcrypt.compare(password, admin.password_hash);
      if (!passwordValid) {
        return res.code(401).send({
          success: false,
          error: { code: "UNAUTHORIZED", message: "Credenciales inválidas" },
        });
      }

      const { accessToken, refreshToken, refreshPayload } = signAdminTokens(app, admin);

      const tokenHash = await bcrypt.hash(refreshToken, 10);
      await prisma.adminSession.create({
        data: {
          id: refreshPayload.sub,
          admin_user_id: admin.id,
          refresh_token_hash: tokenHash,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      await prisma.adminUser.update({
        where: { id: admin.id },
        data: { last_login_at: new Date() },
      });

      return res.send({
        success: true,
        data: {
          accessToken,
          refreshToken,
          admin: { id: admin.id, email: admin.email, fullName: admin.full_name },
        },
      });
    },
  );

  // POST /admin/auth/refresh
  app.post(
    "/refresh",
    {
      schema: {
        tags: ["Admin Auth"],
        summary: "Renovar access token de super administrador",
        security: [],
        body: {
          type: "object",
          required: ["refreshToken"],
          properties: { refreshToken: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "object",
                properties: { accessToken: { type: "string" } },
              },
            },
          },
          401: errorSchema,
        },
      },
    },
    async (req, res) => {
      const { refreshToken } = refreshSchema.parse(req.body);

      let decoded: AdminRefreshTokenPayload;
      try {
        decoded = app.jwt.verify(refreshToken) as AdminRefreshTokenPayload;
      } catch {
        return res.code(401).send({
          success: false,
          error: { code: "UNAUTHORIZED", message: "Refresh token inválido" },
        });
      }

      const session = await prisma.adminSession.findFirst({
        where: {
          id: decoded.sub,
          admin_user_id: decoded.adminId,
          expires_at: { gt: new Date() },
        },
        include: { admin_user: true },
      });

      if (!session) {
        return res.code(401).send({
          success: false,
          error: { code: "UNAUTHORIZED", message: "Sesión inválida o expirada" },
        });
      }

      const valid = await bcrypt.compare(refreshToken, session.refresh_token_hash);
      if (!valid) {
        return res.code(401).send({
          success: false,
          error: { code: "UNAUTHORIZED", message: "Refresh token inválido" },
        });
      }

      const payload: Omit<AdminJwtPayload, "iat" | "exp"> = {
        sub: session.admin_user.id,
        email: session.admin_user.email,
        fullName: session.admin_user.full_name,
        isSuperAdmin: true,
      };
      const newAccessToken = app.jwt.sign(payload, { expiresIn: env.JWT_EXPIRES_IN });

      return res.send({ success: true, data: { accessToken: newAccessToken } });
    },
  );

  // POST /admin/auth/logout
  app.post(
    "/logout",
    {
      schema: {
        tags: ["Admin Auth"],
        summary: "Cerrar sesión de super administrador",
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["refreshToken"],
          properties: { refreshToken: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "object",
                properties: { message: { type: "string" } },
              },
            },
          },
          401: errorSchema,
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
      const admin = req.user as AdminJwtPayload;

      await prisma.adminSession.deleteMany({
        where: { admin_user_id: admin.sub },
      });

      return res.send({ success: true, data: { message: "Sesión cerrada" } });
    },
  );
}

import { AppError } from "@/types";
import { ZodError } from "zod";
export async function errorHandler(app) {
    app.setErrorHandler((error, request, reply) => {
        const err = error;
        // Errores de validación Zod
        if (error instanceof ZodError) {
            return reply.code(422).send({
                success: false,
                error: {
                    code: "VALIDATION_ERROR",
                    message: "Datos de entrada inválidos",
                    details: error.flatten().fieldErrors,
                },
            });
        }
        // Errores de dominios propios
        if (error instanceof AppError) {
            return reply.code(error.statusCode).send({
                success: false,
                error: {
                    code: "CONFLICT",
                    message: "Ya existe un registro con esos datos",
                },
            });
        }
        // Errores de Prisma — constraint unique
        if (err.message?.includes("Unique constraint")) {
            return reply.code(409).send({
                success: false,
                error: {
                    code: "CONFLICT",
                    message: "Ya existe un registro con esos datos",
                },
            });
        }
        // Errores de Prisma — registro no encontrado
        if (err.message?.includes("Record to update not found")) {
            return reply.code(404).send({
                success: false,
                error: {
                    code: "NOT_FOUND",
                    message: "Registro no encontrado",
                },
            });
        }
        // Error genérico — no exponer detalles internos en producción
        app.log.error(error);
        return reply.code(500).send({
            success: false,
            error: {
                code: "INTERNAL_ERROR",
                message: process.env.NODE_ENV === "development"
                    ? err.message
                    : "Error interno del servidor",
            },
        });
    });
    // 404 handler
    app.setNotFoundHandler((request, reply) => {
        reply.code(404).send({
            success: false,
            error: {
                code: "NOT_FOUND",
                message: `Ruta ${request.method} ${request.url} no encontrada`,
            },
        });
    });
}
//# sourceMappingURL=error-handler.js.map
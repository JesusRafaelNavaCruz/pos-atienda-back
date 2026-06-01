// src/modules/suppliers/purchase-orders.public.routes.ts
// Endpoint público para que el proveedor vea su orden escaneando un QR.
// No requiere JWT — el public_token actúa como credencial de solo lectura.
import type { FastifyInstance } from 'fastify'
import prisma from '../../lib/prisma.js'

const errorResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    error: {
      type: 'object',
      properties: { code: { type: 'string' }, message: { type: 'string' } },
    },
  },
}

export async function purchaseOrdersPublicRoutes(app: FastifyInstance) {
  // GET /public/purchase-orders/:token
  app.get('/:token', {
    schema: {
      tags: ['Public'],
      summary: 'Ver orden de compra (acceso de proveedor vía QR)',
      description: `Endpoint público sin autenticación JWT.
El proveedor accede escaneando el QR generado para la orden.
Retorna el detalle de la orden con sus productos, cantidades y costos.`,
      params: {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string', format: 'uuid', description: 'Token público de la orden' },
        },
      },
      response: {
        200: {
          description: 'Detalle de la orden para el proveedor',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                folio:       { type: 'string' },
                status:      { type: 'string' },
                total:       { type: 'number' },
                notes:       { type: 'string', nullable: true },
                expected_at: { type: 'string', nullable: true },
                received_at: { type: 'string', nullable: true },
                created_at:  { type: 'string', format: 'date-time' },
                business:    { type: 'object', nullable: true },
                supplier:    {
                  type: 'object',
                  properties: {
                    name:         { type: 'string' },
                    contact_name: { type: 'string', nullable: true },
                    phone:        { type: 'string', nullable: true },
                    email:        { type: 'string', nullable: true },
                  },
                },
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      product_name: { type: 'string' },
                      barcode:      { type: 'string', nullable: true },
                      unit:         { type: 'string' },
                      quantity:     { type: 'number' },
                      unit_cost:    { type: 'number' },
                      subtotal:     { type: 'number' },
                    },
                  },
                },
              },
            },
          },
        },
        404: { description: 'Orden no encontrada o token inválido', ...errorResponse },
      },
    },
  }, async (req, res) => {
    const { token } = req.params as { token: string }

    const order = await prisma.purchaseOrder.findUnique({
      where: { public_token: token },
      include: {
        tenant:   { select: { name: true } },
        supplier: { select: { name: true, contact_name: true, phone: true, email: true } },
        items: {
          include: {
            product: { select: { name: true, barcode: true, unit: true } },
          },
        },
      },
    })

    if (!order) {
      return res.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Orden no encontrada' },
      })
    }

    return res.send({
      success: true,
      data: {
        folio:       order.folio,
        status:      order.status,
        total:       Number(order.total),
        notes:       order.notes,
        expected_at: order.expected_at,
        received_at: order.received_at,
        created_at:  order.created_at,
        business: order.tenant ? { name: order.tenant.name } : null,
        supplier: order.supplier,
        items: order.items.map((item) => ({
          product_name: item.product.name,
          barcode:      item.product.barcode,
          unit:         item.product.unit,
          quantity:     Number(item.quantity),
          unit_cost:    Number(item.unit_cost),
          subtotal:     Number(item.subtotal),
        })),
      },
    })
  })
}

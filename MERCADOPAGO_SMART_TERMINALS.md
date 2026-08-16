# Mercado Pago: Terminales Smart

La integración usa la API Orders de Mercado Pago Point y OAuth por tenant. Cada
comercio autoriza su propia cuenta Mercado Pago; los tokens se guardan cifrados
en el backend. El frontend solo usa su JWT y nunca recibe credenciales de
Mercado Pago ni datos completos de tarjeta.

## Requisitos de despliegue

1. Aplicar la migración y regenerar Prisma: `npx prisma migrate deploy` y
   `npx prisma generate`.
2. Ejecutar `npm run seed:permissions` para añadir los permisos a roles
   existentes. Los roles personalizados deben recibirlos desde la administración.
3. Configurar `MP_CLIENT_ID`, `MP_CLIENT_SECRET`, URLs OAuth, la clave de cifrado
   `MP_TOKEN_ENCRYPTION_KEY`, `MP_WEBHOOK_SECRET` y `MP_WEBHOOK_URL`.
4. En **Tus integraciones > Webhooks**, registrar
   `https://<api>/webhooks/mercadopago` y activar **Order (Mercado Pago)**.
5. Con un owner, registrar cada terminal para la sucursal correspondiente.

## Permisos y bundle

Todos los endpoints autenticados requieren el feature de plan `card_payments`.

| Operación | Permiso | Roles predeterminados |
| --- | --- | --- |
| Consultar terminales/orden | `mercadopago:read` | owner, manager, cashier |
| Iniciar cobro | `mercadopago:create` | owner, manager, cashier |
| Cancelar orden | `mercadopago:cancel` | owner, manager |
| Reembolsar | `mercadopago:refund` | owner, manager |
| Asignar terminal | owner solamente | owner |

## Endpoints para el frontend

La especificación completa y ejemplos interactivos están en `/docs`, con la
etiqueta **Mercado Pago**. Todas las rutas, salvo el webhook, usan
`Authorization: Bearer <JWT>`.

| Método y ruta | Uso |
| --- | --- |
| `GET /api/v1/mercadopago/terminals` | Terminales autorizadas del tenant. |
| `GET /api/v1/mercadopago/terminals/available` | Owner: descubre terminales de su cuenta Mercado Pago conectada. |
| `GET /api/v1/mercadopago/oauth/connection` | Estado de la cuenta Mercado Pago vinculada. |
| `GET /api/v1/mercadopago/oauth/connect` | Owner: devuelve la URL OAuth a la que debe redirigirse el navegador. |
| `DELETE /api/v1/mercadopago/oauth/connection` | Owner: desactiva la conexión y las terminales locales. |
| `PUT /api/v1/mercadopago/terminals/:terminalId` | Owner: liga una terminal comprobada a una sucursal. |
| `POST /api/v1/mercadopago/orders` | Inicia el cobro y reserva stock. Requiere `Idempotency-Key: <uuid>`. |
| `GET /api/v1/mercadopago/orders/:orderId` | Consulta y sincroniza el estado actual. |
| `POST /api/v1/mercadopago/orders/:orderId/cancel` | Cancela una orden pendiente del tenant. |
| `POST /api/v1/mercadopago/orders/:orderId/refund` | Solicita un reembolso total o parcial. |
| `POST /webhooks/mercadopago` | Exclusivo Mercado Pago; valida firma HMAC. |

### Flujo recomendado de caja

1. Si no existe conexión OAuth, el owner abre `GET /oauth/connect` y redirige el
   navegador a `authorization_url`. Mercado Pago vuelve al callback de backend.
2. El owner asocia físicamente la Point a su cuenta Mercado Pago, selecciona la
   terminal y la asigna a una sucursal del POS.
3. Mostrar las terminales de la sucursal con `GET /terminals`.
2. Generar un UUID nuevo por intento de pago y conservarlo mientras se reintenta
   la misma operación.
3. Enviar carrito, sucursal y terminal a `POST /orders`. El precio no se recibe
   del navegador: el backend usa el catálogo actual y devuelve `order_id`.
4. Mostrar “procesando pago en terminal”. Consultar `GET /orders/:orderId` cada
   2–3 segundos como respaldo visual.
5. Considerar el pago finalizado únicamente con estado `processed`. El webhook
   es la fuente de conciliación; polling no lo sustituye.
6. En cancelación o expiración, el stock reservado se libera automáticamente.

El endpoint legado `POST /sales` ya no acepta `method: "card"`; así se evita que
un navegador pueda registrar una venta de tarjeta sin autorización del adquirente.

## Notas operativas

- Cada terminal debe estar en modo `PDV` y asociada a un Point de Venta en la
  cuenta Mercado Pago antes de utilizarla.
- Mercado Pago permite una orden pendiente por terminal. Ante
  `already_queued_order_for_terminal`, consulta o cancela la orden anterior.
- El backend consulta la Order directamente después de recibir el webhook y no
  confía en el estado recibido en el cuerpo de la notificación.
- El `external_reference` no contiene PII; se genera con el ID interno de venta.
- Reembolsar un pago no repone inventario automáticamente: la devolución física
  debe seguir el proceso de devoluciones de negocio.

Fuentes: [crear Order Point](https://www.mercadopago.com.mx/developers/en/reference/in-person-payments/point/orders/create-order/post), [migración a Orders](https://www.mercadopago.com.mx/developers/es/docs/mp-point/migrate-payment-intent-to-orders) y [validación de Webhooks](https://www.mercadopago.com.mx/developers/es/docs/your-integrations/notifications/webhooks).

# Super Admin - Guía de Uso

## Crear el primer Super Administrador

### Opción 1: Modo interactivo (recomendado)
```bash
npm run seed:admin
```

Responde las preguntas:
- **Email**: correo del administrador
- **Nombre completo**: nombre completo
- **Contraseña**: mínimo 8 caracteres
- **Confirmar**: confirma la contraseña

### Opción 2: Con argumentos CLI
```bash
npm run seed:admin -- --email admin@tenda.com --name "Super Admin" --password "Password123!"
```

### Opción 3: Con variables de ambiente
```bash
ADMIN_EMAIL="admin@tenda.com" \
ADMIN_NAME="Super Admin" \
ADMIN_PASSWORD="Password123!" \
npm run seed:admin
```

---

## Usar el Super Admin

### 1. Login

**Endpoint:**
```
POST /api/v1/admin/auth/login
```

**Body:**
```json
{
  "email": "admin@tenda.com",
  "password": "Password123!"
}

```

**Response:**
```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGc...",
    "refreshToken": "eyJhbGc...",
    "admin": {
      "id": "70233ea4-...",
      "email": "admin@tenda.com",
      "fullName": "Super Admin"
    }
  }
}
```

### 2. Endpoints disponibles

**Gestión de Tenants:**
```
GET    /api/v1/admin/tenants                 → Listar todos los tenants
GET    /api/v1/admin/tenants/:id             → Ver detalle de un tenant
PATCH  /api/v1/admin/tenants/:id/status      → Suspender/reactivar tenant
```

**Usuarios de un Tenant:**
```
GET    /api/v1/admin/tenants/:tenantId/users → Listar usuarios del tenant
```

**Soporte/Impersonación:**
```
POST   /api/v1/admin/impersonate/:tenantId   → Generar token como owner (1h)
```

### 3. Impersonación para soporte

Cuando necesites ayudar a un cliente, genera un token de impersonación:

```bash
POST /api/v1/admin/impersonate/TENANT_ID
Authorization: Bearer ACCESS_TOKEN_ADMIN
```

**Response:**
```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGc...",
    "expiresIn": "1h",
    "tenant": "cliente-slug",
    "impersonating": "owner@cliente.com"
  }
}
```

Luego usa ese `accessToken` para llamar a cualquier endpoint del tenant como si fueras el owner:

```bash
GET /api/v1/users
Authorization: Bearer ACCESS_TOKEN_IMPERSONADO
```

El token tiene una vida de 1 hora y no genera refresh token (por seguridad).

---

## Refresh Token

Si el access token expira, genera uno nuevo:

```
POST /api/v1/admin/auth/refresh
Body: { "refreshToken": "..." }
```

---

## Logout

```
POST /api/v1/admin/auth/logout
Authorization: Bearer ACCESS_TOKEN_ADMIN
Body: { "refreshToken": "..." }
```

---

## Consideraciones de seguridad

- Las credenciales del super admin son las **llaves del reino** — protégelas
- Cada acción de impersonación aparece en el JWT (`impersonatedBy` field)
- Los tokens de impersonación solo duran 1 hora
- Los endpoints `/admin/*` requieren un JWT válido con `isSuperAdmin: true`
- No hay acceso a nivel de BD — todo va por las APIs normales

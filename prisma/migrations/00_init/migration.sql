-- =============================================================================
-- MIGRATION: 01_rls_functions
-- Todo lo que Prisma NO puede generar automáticamente:
--   1. Extensiones de PostgreSQL
--   2. Row-Level Security (RLS) en todas las tablas de negocio
--   3. Triggers para updated_at desde SQL nativo
--   4. Índice parcial para stock bajo
--   5. Funciones PL/pgSQL: onboard_tenant, get_tenant_features,
--      tenant_has_feature, get_low_stock_products
--   6. Rol de BD con permisos mínimos
--   7. Seed: planes, features, catálogo de permisos
--
-- Cómo usar:
--   Después de `prisma migrate dev` o `prisma db push`, ejecutar:
--   psql $DATABASE_URL -f prisma/migrations/00_init/01_rls_functions.sql
-- =============================================================================

-- ─── 1. Extensiones ───────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── 2. Row-Level Security ────────────────────────────────────────────────────
-- Prisma crea las tablas pero NO activa RLS ni las políticas.
-- Sin esto, el aislamiento multi-tenant no existe a nivel de BD.

ALTER TABLE negocio.branches             ENABLE ROW LEVEL SECURITY;
ALTER TABLE negocio.roles                ENABLE ROW LEVEL SECURITY;
ALTER TABLE negocio.users                ENABLE ROW LEVEL SECURITY;
ALTER TABLE negocio.user_sessions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE negocio.suppliers            ENABLE ROW LEVEL SECURITY;
ALTER TABLE negocio.categories           ENABLE ROW LEVEL SECURITY;
ALTER TABLE negocio.products             ENABLE ROW LEVEL SECURITY;
ALTER TABLE negocio.inventory_movements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE negocio.customers            ENABLE ROW LEVEL SECURITY;
ALTER TABLE negocio.sales                ENABLE ROW LEVEL SECURITY;
ALTER TABLE negocio.sale_items           ENABLE ROW LEVEL SECURITY;
ALTER TABLE negocio.payments             ENABLE ROW LEVEL SECURITY;
ALTER TABLE negocio.mercado_pago_terminals ENABLE ROW LEVEL SECURITY;
ALTER TABLE negocio.mercado_pago_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE negocio.mercado_pago_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE negocio.purchase_orders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE negocio.purchase_order_items ENABLE ROW LEVEL SECURITY;

-- Política: cada tabla solo devuelve filas del tenant activo en la sesión.
-- El backend ejecuta: SET LOCAL app.tenant_id = '<uuid>' antes de cada query.

CREATE POLICY tenant_isolation ON negocio.branches
    USING (tenant_id = current_setting('app.tenant_id')::UUID);

CREATE POLICY tenant_isolation ON negocio.roles
    USING (tenant_id = current_setting('app.tenant_id')::UUID);

CREATE POLICY tenant_isolation ON negocio.users
    USING (tenant_id = current_setting('app.tenant_id')::UUID);

CREATE POLICY tenant_isolation ON negocio.user_sessions
    USING (tenant_id = current_setting('app.tenant_id')::UUID);

CREATE POLICY tenant_isolation ON negocio.suppliers
    USING (tenant_id = current_setting('app.tenant_id')::UUID);

CREATE POLICY tenant_isolation ON negocio.categories
    USING (tenant_id = current_setting('app.tenant_id')::UUID);

CREATE POLICY tenant_isolation ON negocio.products
    USING (tenant_id = current_setting('app.tenant_id')::UUID);

CREATE POLICY tenant_isolation ON negocio.inventory_movements
    USING (tenant_id = current_setting('app.tenant_id')::UUID);

CREATE POLICY tenant_isolation ON negocio.customers
    USING (tenant_id = current_setting('app.tenant_id')::UUID);

CREATE POLICY tenant_isolation ON negocio.sales
    USING (tenant_id = current_setting('app.tenant_id')::UUID);

CREATE POLICY tenant_isolation ON negocio.payments
    USING (tenant_id = current_setting('app.tenant_id')::UUID);

CREATE POLICY tenant_isolation ON negocio.mercado_pago_terminals
    USING (tenant_id = current_setting('app.tenant_id')::UUID);
CREATE POLICY tenant_isolation ON negocio.mercado_pago_connections
    USING (tenant_id = current_setting('app.tenant_id')::UUID);
CREATE POLICY tenant_isolation ON negocio.mercado_pago_oauth_states
    USING (tenant_id = current_setting('app.tenant_id')::UUID);

CREATE POLICY tenant_isolation ON negocio.purchase_orders
    USING (tenant_id = current_setting('app.tenant_id')::UUID);

-- sale_items y purchase_order_items: protegidos via subquery a la tabla padre
CREATE POLICY tenant_isolation ON negocio.sale_items
    USING (
        EXISTS (
            SELECT 1 FROM negocio.sales s
            WHERE s.id = sale_id
              AND s.tenant_id = current_setting('app.tenant_id')::UUID
        )
    );

CREATE POLICY tenant_isolation ON negocio.purchase_order_items
    USING (
        EXISTS (
            SELECT 1 FROM negocio.purchase_orders po
            WHERE po.id = order_id
              AND po.tenant_id = current_setting('app.tenant_id')::UUID
        )
    );

-- ─── 3. Función y triggers para updated_at ────────────────────────────────────
-- Prisma maneja @updatedAt solo cuando usa su propio cliente.
-- Queries SQL directas (scripts, herramientas externas, backfills) necesitan este trigger.

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    t TEXT;
    tables TEXT[] := ARRAY[
        'plataforma.plans',
        'plataforma.tenants',
        'plataforma.subscriptions',
        'negocio.branches',
        'negocio.users',
        'negocio.suppliers',
        'negocio.categories',
        'negocio.products',
        'negocio.customers',
        'negocio.sales',
        'negocio.purchase_orders'
    ];
BEGIN
    FOREACH t IN ARRAY tables LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS trg_updated_at ON %s;
             CREATE TRIGGER trg_updated_at
             BEFORE UPDATE ON %s
             FOR EACH ROW EXECUTE FUNCTION update_updated_at()',
            t, t
        );
    END LOOP;
END
$$;

-- ─── 4. Índice parcial para stock bajo ────────────────────────────────────────
-- Prisma no soporta índices parciales con cláusula WHERE.
-- Este índice acelera la query de alertas de stock bajo.

CREATE INDEX IF NOT EXISTS idx_products_stock_low
    ON negocio.products(tenant_id)
    WHERE stock <= min_stock AND is_active = TRUE;

-- ─── 5. Funciones PL/pgSQL ────────────────────────────────────────────────────

-- 5a. Obtener features del tenant activo
CREATE OR REPLACE FUNCTION plataforma.get_tenant_features(p_tenant_id UUID)
RETURNS TABLE(feature_key VARCHAR, limit_value VARCHAR) AS $$
BEGIN
    RETURN QUERY
    SELECT pf.feature_key, pf.limit_value
    FROM plataforma.plan_features pf
    JOIN plataforma.plans pl ON pl.id = pf.plan_id
    JOIN plataforma.subscriptions s ON s.plan_id = pl.id
    WHERE s.tenant_id = p_tenant_id
      AND s.status IN ('active', 'trialing')
    ORDER BY pf.feature_key;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5b. Verificar un feature específico
CREATE OR REPLACE FUNCTION plataforma.tenant_has_feature(
    p_tenant_id UUID,
    p_feature   VARCHAR
) RETURNS BOOLEAN AS $$
DECLARE
    v_value VARCHAR;
BEGIN
    SELECT limit_value INTO v_value
    FROM plataforma.get_tenant_features(p_tenant_id)
    WHERE feature_key = p_feature;
    RETURN FOUND AND v_value NOT IN ('false', '0');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5c. Productos con stock bajo
CREATE OR REPLACE FUNCTION negocio.get_low_stock_products(p_tenant_id UUID)
RETURNS TABLE(
    product_id  UUID,
    name        VARCHAR,
    barcode     VARCHAR,
    stock       NUMERIC,
    min_stock   NUMERIC,
    unit        TEXT
) AS $$
BEGIN
    PERFORM set_config('app.tenant_id', p_tenant_id::TEXT, TRUE);
    RETURN QUERY
    SELECT p.id, p.name, p.barcode, p.stock, p.min_stock, p.unit::TEXT
    FROM negocio.products p
    WHERE p.tenant_id = p_tenant_id
      AND p.is_active = TRUE
      AND p.stock <= p.min_stock
    ORDER BY (p.stock - p.min_stock) ASC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5d. Onboarding completo de tenant nuevo (transacción atómica)
CREATE OR REPLACE FUNCTION plataforma.onboard_tenant(
    p_name          VARCHAR,
    p_slug          VARCHAR,
    p_owner_email   VARCHAR,
    p_owner_name    VARCHAR,
    p_owner_pwd_hash TEXT,
    p_plan_code     VARCHAR DEFAULT 'basic'
) RETURNS TABLE(tenant_id UUID, owner_user_id UUID) AS $$
DECLARE
    v_tenant_id     UUID;
    v_branch_id     UUID;
    v_plan_id       UUID;
    v_role_owner    UUID;
    v_role_manager  UUID;
    v_role_cashier  UUID;
    v_owner_id      UUID;
BEGIN
    INSERT INTO plataforma.tenants (name, slug)
    VALUES (p_name, p_slug)
    RETURNING id INTO v_tenant_id;

    INSERT INTO negocio.branches (tenant_id, name)
    VALUES (v_tenant_id, 'Sucursal principal')
    RETURNING id INTO v_branch_id;

    INSERT INTO negocio.roles (tenant_id, name, code, is_system) VALUES
        (v_tenant_id, 'Dueño',   'owner',   TRUE),
        (v_tenant_id, 'Gerente', 'manager', TRUE),
        (v_tenant_id, 'Cajero',  'cashier', TRUE);

    SELECT id INTO v_role_owner   FROM negocio.roles WHERE tenant_id = v_tenant_id AND code = 'owner';
    SELECT id INTO v_role_manager FROM negocio.roles WHERE tenant_id = v_tenant_id AND code = 'manager';
    SELECT id INTO v_role_cashier FROM negocio.roles WHERE tenant_id = v_tenant_id AND code = 'cashier';

    -- Owner: todos los permisos
    INSERT INTO negocio.role_permissions (role_id, permission_id)
    SELECT v_role_owner, p.id FROM negocio.permissions p;

    -- Manager: operación sin configuración
    INSERT INTO negocio.role_permissions (role_id, permission_id)
    SELECT v_role_manager, p.id FROM negocio.permissions p
    WHERE (p.resource, p.action) IN (
        ('sales','create'),('sales','read'),('sales','cancel'),('sales','return'),('sales','discount'),
        ('products','create'),('products','read'),('products','update'),
        ('inventory','read'),('inventory','adjust'),('inventory','import'),
        ('reports','view_sales'),('reports','export'),
        ('customers','create'),('customers','read'),('customers','update'),
        ('suppliers','read'),('suppliers','create'),('suppliers','update'),
        ('users','create'),('users','read'),('users','update'),
        ('branches','read')
    );

    -- Cajero: solo caja
    INSERT INTO negocio.role_permissions (role_id, permission_id)
    SELECT v_role_cashier, p.id FROM negocio.permissions p
    WHERE (p.resource, p.action) IN (
        ('sales','create'),('sales','read'),
        ('products','read'),
        ('customers','read'),('customers','create'),
        ('reports','view_sales'),
        ('branches','read')
    );

    SELECT id INTO v_plan_id FROM plataforma.plans WHERE code = p_plan_code;

    INSERT INTO plataforma.subscriptions (tenant_id, plan_id, status, trial_ends_at)
    VALUES (v_tenant_id, v_plan_id, 'trialing', NOW() + INTERVAL '14 days');

    INSERT INTO negocio.users (tenant_id, role_id, branch_id, email, password_hash, full_name)
    VALUES (v_tenant_id, v_role_owner, v_branch_id, p_owner_email, p_owner_pwd_hash, p_owner_name)
    RETURNING id INTO v_owner_id;

    RETURN QUERY SELECT v_tenant_id, v_owner_id;
END;
$$ LANGUAGE plpgsql;

-- ─── 6. Rol de BD con permisos mínimos ───────────────────────────────────────

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pos_app') THEN
        CREATE ROLE pos_app WITH LOGIN PASSWORD 'CAMBIAR_EN_PRODUCCION';
    END IF;
END
$$;

GRANT USAGE ON SCHEMA plataforma TO pos_app;
GRANT USAGE ON SCHEMA negocio    TO pos_app;

GRANT SELECT ON plataforma.plans         TO pos_app;
GRANT SELECT ON plataforma.plan_features TO pos_app;
GRANT SELECT, INSERT, UPDATE ON plataforma.tenants        TO pos_app;
GRANT SELECT, INSERT, UPDATE ON plataforma.subscriptions  TO pos_app;
GRANT SELECT, INSERT         ON plataforma.billing_events TO pos_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA negocio TO pos_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA negocio
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pos_app;

-- ─── 7. Seed: planes, features y catálogo de permisos ─────────────────────────

INSERT INTO plataforma.plans (id, name, code, price_mxn, billing_interval, max_branches, max_users, trial_days)
VALUES
    ('00000000-0000-0000-0000-000000000001', 'Básico',     'basic',      299.00,  'monthly', 1,   2,   14),
    ('00000000-0000-0000-0000-000000000002', 'Pro',        'pro',        699.00,  'monthly', 1,   5,   14),
    ('00000000-0000-0000-0000-000000000003', 'Enterprise', 'enterprise', 1499.00, 'monthly', 999, 999, 14)
ON CONFLICT (code) DO NOTHING;

INSERT INTO plataforma.plan_features (plan_id, feature_key, limit_value) VALUES
    ('00000000-0000-0000-0000-000000000001','card_payments','false'),
    ('00000000-0000-0000-0000-000000000001','csv_import','false'),
    ('00000000-0000-0000-0000-000000000001','scale','false'),
    ('00000000-0000-0000-0000-000000000001','thermal_printer','false'),
    ('00000000-0000-0000-0000-000000000001','multi_branch','false'),
    ('00000000-0000-0000-0000-000000000001','advanced_reports','false'),
    ('00000000-0000-0000-0000-000000000001','api_access','false'),
    ('00000000-0000-0000-0000-000000000001','suppliers','false'),
    ('00000000-0000-0000-0000-000000000001','customers','true'),
    ('00000000-0000-0000-0000-000000000001','stock_alerts','true'),
    ('00000000-0000-0000-0000-000000000001','basic_reports','true'),
    ('00000000-0000-0000-0000-000000000002','card_payments','true'),
    ('00000000-0000-0000-0000-000000000002','csv_import','true'),
    ('00000000-0000-0000-0000-000000000002','scale','true'),
    ('00000000-0000-0000-0000-000000000002','thermal_printer','true'),
    ('00000000-0000-0000-0000-000000000002','multi_branch','false'),
    ('00000000-0000-0000-0000-000000000002','advanced_reports','true'),
    ('00000000-0000-0000-0000-000000000002','api_access','false'),
    ('00000000-0000-0000-0000-000000000002','suppliers','true'),
    ('00000000-0000-0000-0000-000000000002','customers','true'),
    ('00000000-0000-0000-0000-000000000002','stock_alerts','true'),
    ('00000000-0000-0000-0000-000000000002','basic_reports','true'),
    ('00000000-0000-0000-0000-000000000003','card_payments','true'),
    ('00000000-0000-0000-0000-000000000003','csv_import','true'),
    ('00000000-0000-0000-0000-000000000003','scale','true'),
    ('00000000-0000-0000-0000-000000000003','thermal_printer','true'),
    ('00000000-0000-0000-0000-000000000003','multi_branch','true'),
    ('00000000-0000-0000-0000-000000000003','advanced_reports','true'),
    ('00000000-0000-0000-0000-000000000003','api_access','true'),
    ('00000000-0000-0000-0000-000000000003','suppliers','true'),
    ('00000000-0000-0000-0000-000000000003','customers','true'),
    ('00000000-0000-0000-0000-000000000003','stock_alerts','true'),
    ('00000000-0000-0000-0000-000000000003','basic_reports','true')
ON CONFLICT (plan_id, feature_key) DO NOTHING;

INSERT INTO negocio.permissions (resource, action, description) VALUES
    ('sales','create','Crear ventas'),
    ('sales','read','Ver historial de ventas'),
    ('sales','cancel','Cancelar ventas'),
    ('sales','return','Procesar devoluciones'),
    ('sales','discount','Aplicar descuentos'),
    ('products','create','Crear productos'),
    ('products','read','Ver catálogo de productos'),
    ('products','update','Editar productos'),
    ('products','delete','Eliminar productos'),
    ('inventory','read','Ver movimientos de inventario'),
    ('inventory','adjust','Hacer ajustes de stock'),
    ('inventory','import','Importar productos desde CSV'),
    ('reports','view_sales','Ver reportes de ventas'),
    ('reports','view_finance','Ver reportes financieros'),
    ('reports','export','Exportar reportes'),
    ('customers','create','Registrar clientes'),
    ('customers','read','Ver clientes'),
    ('customers','update','Editar clientes'),
    ('customers','delete','Eliminar clientes'),
    ('suppliers','create','Registrar proveedores'),
    ('suppliers','read','Ver proveedores'),
    ('suppliers','update','Editar proveedores'),
    ('suppliers','delete','Eliminar proveedores'),
    ('users','create','Crear usuarios'),
    ('users','read','Ver usuarios'),
    ('users','update','Editar usuarios'),
    ('users','delete','Eliminar usuarios'),
    ('branches','create','Crear sucursales'),
    ('branches','read','Ver sucursales'),
    ('branches','update','Editar sucursales'),
    ('branches','delete','Eliminar sucursales'),
    ('subscription','manage','Gestionar suscripción'),
    ('settings','manage','Configuración general')
ON CONFLICT (resource, action) DO NOTHING;

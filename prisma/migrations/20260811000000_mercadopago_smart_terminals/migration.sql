-- Persistencia y aislamiento de Mercado Pago Point / Terminales Smart.
ALTER TABLE negocio.payments
  ADD COLUMN mercado_pago_order_id VARCHAR(80),
  ADD COLUMN mercado_pago_idempotency_key VARCHAR(80),
  ADD COLUMN mercado_pago_terminal_id VARCHAR(120),
  ADD COLUMN mercado_pago_status VARCHAR(40);

CREATE UNIQUE INDEX payments_mercado_pago_order_id_key
  ON negocio.payments(mercado_pago_order_id)
  WHERE mercado_pago_order_id IS NOT NULL;

CREATE UNIQUE INDEX payments_mercado_pago_idempotency_key_key
  ON negocio.payments(mercado_pago_idempotency_key)
  WHERE mercado_pago_idempotency_key IS NOT NULL;

CREATE TABLE negocio.mercado_pago_terminals (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  branch_id UUID NOT NULL,
  terminal_id VARCHAR(120) NOT NULL,
  name VARCHAR(200),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT mercado_pago_terminals_pkey PRIMARY KEY (id),
  CONSTRAINT mercado_pago_terminals_terminal_id_key UNIQUE (terminal_id),
  CONSTRAINT mercado_pago_terminals_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES plataforma.tenants(id) ON DELETE CASCADE,
  CONSTRAINT mercado_pago_terminals_branch_id_fkey
    FOREIGN KEY (branch_id) REFERENCES negocio.branches(id) ON DELETE CASCADE,
  CONSTRAINT mercado_pago_terminals_tenant_branch_terminal_key
    UNIQUE (tenant_id, branch_id, terminal_id)
);

CREATE INDEX idx_mercado_pago_terminals_tenant_branch
  ON negocio.mercado_pago_terminals(tenant_id, branch_id);

ALTER TABLE negocio.mercado_pago_terminals ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON negocio.mercado_pago_terminals
  USING (tenant_id = current_setting('app.tenant_id')::UUID);

-- @updatedAt es gestionado por Prisma. El grant se aplica solo cuando el rol
-- restringido instalado por 01_rls_functions.sql ya existe.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pos_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON negocio.mercado_pago_terminals TO pos_app;
  END IF;
END
$$;

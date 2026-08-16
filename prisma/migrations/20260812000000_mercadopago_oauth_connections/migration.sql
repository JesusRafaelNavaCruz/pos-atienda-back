CREATE TABLE negocio.mercado_pago_connections (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  collector_id VARCHAR(80) NOT NULL,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT mercado_pago_connections_pkey PRIMARY KEY (id),
  CONSTRAINT mercado_pago_connections_tenant_id_key UNIQUE (tenant_id),
  CONSTRAINT mercado_pago_connections_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES plataforma.tenants(id) ON DELETE CASCADE
);

CREATE TABLE negocio.mercado_pago_oauth_states (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  state_hash VARCHAR(128) NOT NULL,
  code_verifier_encrypted TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT mercado_pago_oauth_states_pkey PRIMARY KEY (id),
  CONSTRAINT mercado_pago_oauth_states_state_hash_key UNIQUE (state_hash),
  CONSTRAINT mercado_pago_oauth_states_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES plataforma.tenants(id) ON DELETE CASCADE,
  CONSTRAINT mercado_pago_oauth_states_user_id_fkey FOREIGN KEY (user_id) REFERENCES negocio.users(id) ON DELETE CASCADE
);

CREATE INDEX idx_mercado_pago_oauth_states_tenant ON negocio.mercado_pago_oauth_states(tenant_id);
CREATE INDEX idx_mercado_pago_oauth_states_expires ON negocio.mercado_pago_oauth_states(expires_at);

ALTER TABLE negocio.mercado_pago_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE negocio.mercado_pago_oauth_states ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON negocio.mercado_pago_connections USING (tenant_id = current_setting('app.tenant_id')::UUID);
CREATE POLICY tenant_isolation ON negocio.mercado_pago_oauth_states USING (tenant_id = current_setting('app.tenant_id')::UUID);

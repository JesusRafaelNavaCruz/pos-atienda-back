-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "negocio";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "plataforma";

-- CreateEnum
CREATE TYPE "plataforma"."BillingInterval" AS ENUM ('monthly', 'yearly');

-- CreateEnum
CREATE TYPE "plataforma"."TenantStatus" AS ENUM ('active', 'suspended', 'canceled', 'trial');

-- CreateEnum
CREATE TYPE "plataforma"."SubscriptionStatus" AS ENUM ('trialing', 'active', 'past_due', 'canceled', 'unpaid');

-- CreateEnum
CREATE TYPE "negocio"."ProductUnit" AS ENUM ('pza', 'kg', 'g', 'lt', 'ml', 'caja', 'paq', 'rollo', 'par');

-- CreateEnum
CREATE TYPE "negocio"."InventoryMovementType" AS ENUM ('sale', 'purchase', 'adjustment', 'return', 'loss', 'initial');

-- CreateEnum
CREATE TYPE "negocio"."SaleStatus" AS ENUM ('pending', 'completed', 'canceled', 'returned');

-- CreateEnum
CREATE TYPE "negocio"."PaymentMethod" AS ENUM ('cash', 'card', 'transfer', 'credit');

-- CreateEnum
CREATE TYPE "negocio"."PaymentStatus" AS ENUM ('pending', 'completed', 'failed', 'refunded');

-- CreateEnum
CREATE TYPE "negocio"."PurchaseOrderStatus" AS ENUM ('draft', 'sent', 'received', 'canceled');

-- CreateTable
CREATE TABLE "plataforma"."plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(100) NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "price_mxn" DECIMAL(10,2) NOT NULL,
    "billing_interval" "plataforma"."BillingInterval" NOT NULL DEFAULT 'monthly',
    "max_branches" INTEGER NOT NULL DEFAULT 1,
    "max_users" INTEGER NOT NULL DEFAULT 2,
    "trial_days" INTEGER NOT NULL DEFAULT 14,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plataforma"."plan_features" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "plan_id" UUID NOT NULL,
    "feature_key" VARCHAR(100) NOT NULL,
    "limit_value" VARCHAR(50) NOT NULL DEFAULT 'true',

    CONSTRAINT "plan_features_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plataforma"."tenants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "status" "plataforma"."TenantStatus" NOT NULL DEFAULT 'active',
    "timezone" VARCHAR(60) NOT NULL DEFAULT 'America/Mexico_City',
    "country" CHAR(2) NOT NULL DEFAULT 'MX',
    "logo_url" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plataforma"."subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "stripe_subscription_id" VARCHAR(200),
    "stripe_customer_id" VARCHAR(200),
    "status" "plataforma"."SubscriptionStatus" NOT NULL DEFAULT 'trialing',
    "current_period_start" TIMESTAMPTZ,
    "current_period_end" TIMESTAMPTZ,
    "trial_ends_at" TIMESTAMPTZ,
    "canceled_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plataforma"."billing_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID,
    "stripe_event_id" VARCHAR(200) NOT NULL,
    "event_type" VARCHAR(100) NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "processed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plataforma"."admin_users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" VARCHAR(255) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" VARCHAR(200) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plataforma"."admin_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "admin_user_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "negocio"."branches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "address" TEXT,
    "phone" VARCHAR(30),
    "email" VARCHAR(200),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "negocio"."roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "negocio"."permissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "resource" VARCHAR(80) NOT NULL,
    "action" VARCHAR(40) NOT NULL,
    "description" VARCHAR(255),

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "negocio"."role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "negocio"."users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "branch_id" UUID,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" VARCHAR(200) NOT NULL,
    "pin_hash" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "negocio"."user_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "ip_address" INET,
    "user_agent" TEXT,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "negocio"."categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "color" VARCHAR(7) DEFAULT '#6B7280',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "negocio"."suppliers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "contact_name" VARCHAR(200),
    "phone" VARCHAR(30),
    "email" VARCHAR(255),
    "rfc" VARCHAR(13),
    "address" TEXT,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "negocio"."products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "category_id" UUID,
    "supplier_id" UUID,
    "barcode" VARCHAR(100),
    "sku" VARCHAR(100),
    "name" VARCHAR(300) NOT NULL,
    "description" TEXT,
    "unit" "negocio"."ProductUnit" NOT NULL DEFAULT 'pza',
    "price" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "cost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "stock" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "min_stock" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "sold_by_weight" BOOLEAN NOT NULL DEFAULT false,
    "image_url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "negocio"."inventory_movements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "user_id" UUID,
    "branch_id" UUID,
    "type" "negocio"."InventoryMovementType" NOT NULL,
    "quantity_before" DECIMAL(12,3) NOT NULL,
    "quantity_after" DECIMAL(12,3) NOT NULL,
    "delta" DECIMAL(12,3) NOT NULL,
    "reason" TEXT,
    "reference_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "negocio"."customers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "phone" VARCHAR(30),
    "email" VARCHAR(255),
    "rfc" VARCHAR(13),
    "address" TEXT,
    "credit_limit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "credit_balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "loyalty_points" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "negocio"."sales" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "customer_id" UUID,
    "folio" VARCHAR(30) NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "negocio"."SaleStatus" NOT NULL DEFAULT 'completed',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "negocio"."sale_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sale_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "sale_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "negocio"."payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sale_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "method" "negocio"."PaymentMethod" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "change_given" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "stripe_payment_id" VARCHAR(200),
    "stripe_terminal_id" VARCHAR(200),
    "card_last4" CHAR(4),
    "card_brand" VARCHAR(20),
    "status" "negocio"."PaymentStatus" NOT NULL DEFAULT 'completed',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "negocio"."purchase_orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "user_id" UUID,
    "branch_id" UUID,
    "folio" VARCHAR(30) NOT NULL,
    "status" "negocio"."PurchaseOrderStatus" NOT NULL DEFAULT 'draft',
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "expected_at" DATE,
    "received_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "negocio"."purchase_order_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit_cost" DECIMAL(12,2) NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "purchase_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plataforma"."plans"("code");

-- CreateIndex
CREATE INDEX "idx_plan_features_plan" ON "plataforma"."plan_features"("plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_features_plan_id_feature_key_key" ON "plataforma"."plan_features"("plan_id", "feature_key");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "plataforma"."tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_stripe_subscription_id_key" ON "plataforma"."subscriptions"("stripe_subscription_id");

-- CreateIndex
CREATE INDEX "idx_subscriptions_tenant" ON "plataforma"."subscriptions"("tenant_id");

-- CreateIndex
CREATE INDEX "idx_subscriptions_status" ON "plataforma"."subscriptions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "billing_events_stripe_event_id_key" ON "plataforma"."billing_events"("stripe_event_id");

-- CreateIndex
CREATE INDEX "idx_billing_events_tenant" ON "plataforma"."billing_events"("tenant_id");

-- CreateIndex
CREATE INDEX "idx_billing_events_type" ON "plataforma"."billing_events"("event_type");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "plataforma"."admin_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "admin_sessions_refresh_token_hash_key" ON "plataforma"."admin_sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "idx_admin_sessions_user" ON "plataforma"."admin_sessions"("admin_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenant_id_code_key" ON "negocio"."roles"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_resource_action_key" ON "negocio"."permissions"("resource", "action");

-- CreateIndex
CREATE INDEX "idx_users_tenant" ON "negocio"."users"("tenant_id");

-- CreateIndex
CREATE INDEX "idx_users_email" ON "negocio"."users"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_email_key" ON "negocio"."users"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_refresh_token_hash_key" ON "negocio"."user_sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "idx_sessions_user" ON "negocio"."user_sessions"("user_id");

-- CreateIndex
CREATE INDEX "idx_sessions_token" ON "negocio"."user_sessions"("refresh_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "categories_tenant_id_name_key" ON "negocio"."categories"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "idx_suppliers_tenant" ON "negocio"."suppliers"("tenant_id");

-- CreateIndex
CREATE INDEX "idx_products_tenant" ON "negocio"."products"("tenant_id");

-- CreateIndex
CREATE INDEX "idx_products_barcode" ON "negocio"."products"("tenant_id", "barcode");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenant_id_barcode_key" ON "negocio"."products"("tenant_id", "barcode");

-- CreateIndex
CREATE INDEX "idx_inventory_product" ON "negocio"."inventory_movements"("product_id");

-- CreateIndex
CREATE INDEX "idx_inventory_tenant" ON "negocio"."inventory_movements"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_customers_tenant" ON "negocio"."customers"("tenant_id");

-- CreateIndex
CREATE INDEX "idx_sales_tenant" ON "negocio"."sales"("tenant_id");

-- CreateIndex
CREATE INDEX "idx_sales_branch" ON "negocio"."sales"("branch_id");

-- CreateIndex
CREATE INDEX "idx_sales_user" ON "negocio"."sales"("user_id");

-- CreateIndex
CREATE INDEX "idx_sales_created_at" ON "negocio"."sales"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "sales_tenant_id_folio_key" ON "negocio"."sales"("tenant_id", "folio");

-- CreateIndex
CREATE INDEX "idx_sale_items_sale" ON "negocio"."sale_items"("sale_id");

-- CreateIndex
CREATE INDEX "idx_sale_items_product" ON "negocio"."sale_items"("product_id");

-- CreateIndex
CREATE INDEX "idx_payments_sale" ON "negocio"."payments"("sale_id");

-- CreateIndex
CREATE INDEX "idx_payments_tenant" ON "negocio"."payments"("tenant_id");

-- CreateIndex
CREATE INDEX "idx_purchase_orders_tenant" ON "negocio"."purchase_orders"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_tenant_id_folio_key" ON "negocio"."purchase_orders"("tenant_id", "folio");

-- AddForeignKey
ALTER TABLE "plataforma"."plan_features" ADD CONSTRAINT "plan_features_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plataforma"."plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plataforma"."subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "plataforma"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plataforma"."subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plataforma"."plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plataforma"."billing_events" ADD CONSTRAINT "billing_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "plataforma"."tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plataforma"."admin_sessions" ADD CONSTRAINT "admin_sessions_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "plataforma"."admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."branches" ADD CONSTRAINT "branches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "plataforma"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."roles" ADD CONSTRAINT "roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "plataforma"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "negocio"."roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "negocio"."permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "plataforma"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."users" ADD CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "negocio"."roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."users" ADD CONSTRAINT "users_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "negocio"."branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."user_sessions" ADD CONSTRAINT "user_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "plataforma"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "negocio"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."categories" ADD CONSTRAINT "categories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "plataforma"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."suppliers" ADD CONSTRAINT "suppliers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "plataforma"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."products" ADD CONSTRAINT "products_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "plataforma"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "negocio"."categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."products" ADD CONSTRAINT "products_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "negocio"."suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."inventory_movements" ADD CONSTRAINT "inventory_movements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "plataforma"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."inventory_movements" ADD CONSTRAINT "inventory_movements_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "negocio"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."inventory_movements" ADD CONSTRAINT "inventory_movements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "negocio"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."inventory_movements" ADD CONSTRAINT "inventory_movements_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "negocio"."branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."customers" ADD CONSTRAINT "customers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "plataforma"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."sales" ADD CONSTRAINT "sales_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "plataforma"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."sales" ADD CONSTRAINT "sales_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "negocio"."branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."sales" ADD CONSTRAINT "sales_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "negocio"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."sales" ADD CONSTRAINT "sales_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "negocio"."customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."sale_items" ADD CONSTRAINT "sale_items_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "negocio"."sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."sale_items" ADD CONSTRAINT "sale_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "negocio"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."payments" ADD CONSTRAINT "payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "plataforma"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."payments" ADD CONSTRAINT "payments_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "negocio"."sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."purchase_orders" ADD CONSTRAINT "purchase_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "plataforma"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "negocio"."suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."purchase_orders" ADD CONSTRAINT "purchase_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "negocio"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."purchase_orders" ADD CONSTRAINT "purchase_orders_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "negocio"."branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."purchase_order_items" ADD CONSTRAINT "purchase_order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "negocio"."purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio"."purchase_order_items" ADD CONSTRAINT "purchase_order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "negocio"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

// src/lib/seed.ts
// Pobla los planes de suscripción en la BD.
// Ejecutar con: npm run db:seed
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ─── Definición de planes ─────────────────────────────────────────────────────

const plans = [
  {
    code: "basic",
    name: "Básico",
    price_mxn: 199.0,
    billing_interval: "monthly" as const,
    max_users: 3,
    max_branches: 1,
    trial_days: 14,
    features: [
      // El plan básico NO tiene features avanzados.
      // Los módulos protegidos (customers, suppliers, etc.) no están disponibles.
    ],
  },
  {
    code: "pro",
    name: "Pro",
    price_mxn: 499.0,
    billing_interval: "monthly" as const,
    max_users: 10,
    max_branches: 3,
    trial_days: 14,
    features: [
      { feature_key: "customers",    limit_value: "true" },
      { feature_key: "suppliers",    limit_value: "true" },
      { feature_key: "csv_import",   limit_value: "true" },
      { feature_key: "card_payments", limit_value: "true" },
    ],
  },
  {
    code: "enterprise",
    name: "Enterprise",
    price_mxn: 999.0,
    billing_interval: "monthly" as const,
    max_users: 50,
    max_branches: 10,
    trial_days: 14,
    features: [
      { feature_key: "customers",        limit_value: "true" },
      { feature_key: "suppliers",        limit_value: "true" },
      { feature_key: "csv_import",       limit_value: "true" },
      { feature_key: "card_payments",    limit_value: "true" },
      { feature_key: "advanced_reports", limit_value: "true" },
    ],
  },
];

// ─── Seed ─────────────────────────────────────────────────────────────────────

async function seed() {
  console.log("🌱  Iniciando seed de planes...\n");

  for (const plan of plans) {
    const { features, ...planData } = plan;

    // Upsert del plan (idempotente)
    const upserted = await prisma.plan.upsert({
      where: { code: plan.code },
      create: planData,
      update: {
        name:             planData.name,
        price_mxn:        planData.price_mxn,
        billing_interval: planData.billing_interval,
        max_users:        planData.max_users,
        max_branches:     planData.max_branches,
        trial_days:       planData.trial_days,
        is_active:        true,
      },
    });

    console.log(`  ✓  Plan "${upserted.name}" (${upserted.code}) — $${upserted.price_mxn} MXN/mes`);

    // Eliminar features anteriores y recrear (más simple que upsert por par)
    await prisma.planFeature.deleteMany({ where: { plan_id: upserted.id } });

    if (features.length > 0) {
      await prisma.planFeature.createMany({
        data: features.map((f) => ({ ...f, plan_id: upserted.id })),
      });
      console.log(`     Features: ${features.map((f) => f.feature_key).join(", ")}`);
    } else {
      console.log(`     Features: ninguno (plan básico)`);
    }
  }

  console.log("\n✅  Seed completado.");
  console.log("\nPlanes disponibles:");
  console.log("  básico     → $199/mes  | 3 usuarios  | 1 sucursal  | sin features avanzados");
  console.log("  pro        → $499/mes  | 10 usuarios | 3 sucursales | customers, suppliers, csv, card payments");
  console.log("  enterprise → $999/mes  | 50 usuarios | 10 sucursales | todo lo anterior + advanced reports");
}

seed()
  .catch((e) => {
    console.error("❌  Error en seed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

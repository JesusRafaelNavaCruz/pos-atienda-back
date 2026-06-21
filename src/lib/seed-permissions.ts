// src/lib/seed-permissions.ts
// Pobla la tabla Permission con el catálogo global y asigna permisos
// a los roles manager y cashier de todos los tenants existentes.
// Ejecutar con: npm run seed:permissions
import { PrismaClient } from '@prisma/client'
import { ALL_PERMISSIONS, MANAGER_PERMISSIONS, CASHIER_PERMISSIONS } from './rbac-matrix.js'

const prisma = new PrismaClient()

async function seed() {
  console.log('🌱  Iniciando seed de permisos...\n')

  // 1. Upsert del catálogo global de permisos
  for (const [resource, action, description] of ALL_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { resource_action: { resource, action } },
      create: { resource, action, description },
      update: { description },
    })
  }
  console.log(`  ✓  ${ALL_PERMISSIONS.length} permisos inicializados`)

  // 2. Construir mapa id por "resource:action"
  const allPerms = await prisma.permission.findMany()
  const permMap = new Map(allPerms.map(p => [`${p.resource}:${p.action}`, p.id]))

  // 3. Asignar permisos a roles manager y cashier de cada tenant existente
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } })
  let totalAssigned = 0

  for (const tenant of tenants) {
    const [managerRole, cashierRole] = await Promise.all([
      prisma.role.findFirst({ where: { tenant_id: tenant.id, code: 'manager' } }),
      prisma.role.findFirst({ where: { tenant_id: tenant.id, code: 'cashier' } }),
    ])

    const records: { role_id: string; permission_id: string }[] = []

    if (managerRole) {
      for (const [resource, action] of MANAGER_PERMISSIONS) {
        const pid = permMap.get(`${resource}:${action}`)
        if (pid) records.push({ role_id: managerRole.id, permission_id: pid })
      }
    }

    if (cashierRole) {
      for (const [resource, action] of CASHIER_PERMISSIONS) {
        const pid = permMap.get(`${resource}:${action}`)
        if (pid) records.push({ role_id: cashierRole.id, permission_id: pid })
      }
    }

    if (records.length > 0) {
      await prisma.rolePermission.createMany({ data: records, skipDuplicates: true })
      totalAssigned += records.length
      console.log(`  ✓  "${tenant.name}": ${records.length} permisos asignados`)
    } else {
      console.log(`  ⚠  "${tenant.name}": sin roles manager/cashier encontrados`)
    }
  }

  console.log(`\n✅  Seed completado.`)
  console.log(`   ${ALL_PERMISSIONS.length} permisos en catálogo`)
  console.log(`   ${totalAssigned} role-permissions asignados en ${tenants.length} tenants`)
}

seed()
  .catch(e => {
    console.error('❌  Error en seed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

// src/lib/rbac.ts
// Helper para asignar permisos predeterminados a nuevos tenants durante el onboarding.
import prisma, { tenantStorage } from './prisma.js'
import { MANAGER_PERMISSIONS, CASHIER_PERMISSIONS } from './rbac-matrix.js'

export async function assignDefaultPermissions(tenantId: string): Promise<void> {
  const [managerRole, cashierRole, allPerms] = await Promise.all([
    tenantStorage.run(tenantId, () =>
      prisma.role.findFirst({ where: { tenant_id: tenantId, code: 'manager' } }),
    ),
    tenantStorage.run(tenantId, () =>
      prisma.role.findFirst({ where: { tenant_id: tenantId, code: 'cashier' } }),
    ),
    prisma.permission.findMany({ select: { id: true, resource: true, action: true } }),
  ])

  if (!managerRole && !cashierRole) return

  const permMap = new Map(allPerms.map(p => [`${p.resource}:${p.action}`, p.id]))
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
  }
}

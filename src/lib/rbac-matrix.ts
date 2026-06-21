// Catálogo global de permisos y matriz de permisos por rol predeterminado.
// Importado tanto por el seed como por el helper de onboarding.

export type PermissionTuple = [resource: string, action: string]

export const ALL_PERMISSIONS: Array<[string, string, string]> = [
  // [resource, action, description]
  ['products',        'read',         'Ver productos'],
  ['products',        'create',       'Crear productos'],
  ['products',        'update',       'Editar productos'],
  ['products',        'delete',       'Eliminar productos'],
  ['inventory',       'read',         'Ver movimientos de inventario'],
  ['inventory',       'adjust',       'Ajustar inventario manualmente'],
  ['inventory',       'import',       'Importar productos por CSV'],
  ['customers',       'read',         'Ver clientes'],
  ['customers',       'create',       'Crear clientes'],
  ['customers',       'update',       'Editar clientes'],
  ['customers',       'delete',       'Eliminar clientes'],
  ['users',           'read',         'Ver usuarios y roles'],
  ['users',           'create',       'Crear usuarios'],
  ['users',           'update',       'Editar usuarios'],
  ['users',           'delete',       'Desactivar usuarios'],
  ['reports',         'view_sales',   'Ver reportes de ventas'],
  ['reports',         'view_finance', 'Ver reportes financieros'],
  ['purchase_orders', 'read',         'Ver órdenes de compra'],
  ['purchase_orders', 'create',       'Crear órdenes de compra'],
  ['purchase_orders', 'update',       'Actualizar órdenes de compra'],
  ['suppliers',       'read',         'Ver proveedores'],
  ['suppliers',       'create',       'Crear proveedores'],
  ['suppliers',       'update',       'Editar proveedores'],
  ['suppliers',       'delete',       'Eliminar proveedores'],
  ['sales',           'read',         'Ver ventas'],
  ['sales',           'create',       'Crear ventas'],
  ['sales',           'cancel',       'Cancelar ventas'],
]

export const MANAGER_PERMISSIONS: PermissionTuple[] = [
  ['products',        'read'],
  ['products',        'create'],
  ['products',        'update'],
  ['products',        'delete'],
  ['inventory',       'read'],
  ['inventory',       'adjust'],
  ['inventory',       'import'],
  ['customers',       'read'],
  ['customers',       'create'],
  ['customers',       'update'],
  ['customers',       'delete'],
  ['users',           'read'],
  ['users',           'create'],
  ['users',           'update'],
  ['users',           'delete'],
  ['reports',         'view_sales'],
  ['reports',         'view_finance'],
  ['purchase_orders', 'read'],
  ['purchase_orders', 'create'],
  ['purchase_orders', 'update'],
  ['suppliers',       'read'],
  ['suppliers',       'create'],
  ['suppliers',       'update'],
  ['suppliers',       'delete'],
  ['sales',           'read'],
  ['sales',           'create'],
  ['sales',           'cancel'],
]

export const CASHIER_PERMISSIONS: PermissionTuple[] = [
  ['products',  'read'],
  ['customers', 'read'],
  ['customers', 'create'],
  ['sales',     'read'],
  ['sales',     'create'],
]

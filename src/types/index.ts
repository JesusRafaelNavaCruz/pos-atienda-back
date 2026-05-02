//Errores de dominio 
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}

// Feature Flags
export type FeatureKey =
  | 'card_payments'
  | 'csv_import'
  | 'scale'
  | 'thermal_printer'
  | 'multi_branch'
  | 'advanced_reports'
  | 'api_access'
  | 'suppliers'
  | 'customers'
  | 'stock_alerts'
  | 'basic_reports'

// JWT Payload
export interface JwtPayload {
  sub: string          // user id
  tenantId: string
  roleCode: string     // 'owner' | 'manager' | 'cashier' | custom
  branchId: string | null
  email: string
  iat?: number
  exp?: number
}

export interface RefreshTokenPayload {
  sub: string          // session id
  userId: string
  tenantId: string
}

export interface AdminJwtPayload {
  sub: string          // admin user id
  email: string
  fullName: string
  isSuperAdmin: true
  iat?: number
  exp?: number
}

export interface AdminRefreshTokenPayload {
  sub: string          // session id
  adminId: string
}

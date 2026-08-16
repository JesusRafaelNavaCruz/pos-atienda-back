export declare class AppError extends Error {
    readonly code: string;
    readonly statusCode: number;
    constructor(code: string, message: string, statusCode?: number);
}
export type FeatureKey = 'card_payments' | 'csv_import' | 'scale' | 'thermal_printer' | 'multi_branch' | 'advanced_reports' | 'api_access' | 'suppliers' | 'customers' | 'stock_alerts' | 'basic_reports';
export interface JwtPayload {
    sub: string;
    tenantId: string;
    roleCode: string;
    branchId: string | null;
    email: string;
    iat?: number;
    exp?: number;
}
export interface RefreshTokenPayload {
    sub: string;
    userId: string;
    tenantId: string;
}
export interface AdminJwtPayload {
    sub: string;
    email: string;
    fullName: string;
    isSuperAdmin: true;
    iat?: number;
    exp?: number;
}
export interface AdminRefreshTokenPayload {
    sub: string;
    adminId: string;
}
//# sourceMappingURL=index.d.ts.map
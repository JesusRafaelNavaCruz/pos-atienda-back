import Redis from 'ioredis';
export declare function getRedis(): Redis | null;
export declare const featureCache: {
    key: (tenantId: string) => string;
    get(tenantId: string): Promise<Record<string, string> | null>;
    set(tenantId: string, features: Record<string, string>, ttl: number): Promise<void>;
    del(tenantId: string): Promise<void>;
};
export default getRedis;
//# sourceMappingURL=redis.d.ts.map
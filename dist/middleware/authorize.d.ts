import type { FeatureKey } from "@/types";
import { FastifyReply, FastifyRequest } from "fastify";
export declare function requireFeature(featureKey: FeatureKey): (req: FastifyRequest, res: FastifyReply) => Promise<undefined>;
export declare function requirePermission(resource: string, action: string): (req: FastifyRequest, res: FastifyReply) => Promise<undefined>;
export declare function requireSuperAdmin(): (req: FastifyRequest, res: FastifyReply) => Promise<undefined>;
//# sourceMappingURL=authorize.d.ts.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.create = void 0;
const prisma_1 = require("@/lib/prisma");
const zod_1 = require("zod");
const authMiddleware_1 = require("@/middleware/authMiddleware");
const createPixKeySchema = zod_1.z.object({
    owner_type: zod_1.z.enum(['customer', 'entity']),
    key_type: zod_1.z.enum(['cpf', 'cnpj', 'email', 'phone', 'random']),
    key_value: zod_1.z.string(),
    label: zod_1.z.string().optional()
});
const create = async (event) => {
    try {
        (0, authMiddleware_1.verifyToken)(event);
        const ownerId = event.pathParameters?.id;
        if (!ownerId) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Owner ID is required in path' })
            };
        }
        const body = JSON.parse(event.body || '{}');
        const parsed = createPixKeySchema.safeParse(body);
        if (!parsed.success) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: 'Invalid payload',
                    details: parsed.error.flatten()
                })
            };
        }
        const { owner_type, key_type, key_value, label } = parsed.data;
        const pixKey = await prisma_1.prisma.core_pix_keys.create({
            data: {
                key_type,
                key_value,
                label,
                customer_id: owner_type === 'customer' ? ownerId : undefined,
                entity_id: owner_type === 'entity' ? ownerId : undefined
            }
        });
        return {
            statusCode: 201,
            body: JSON.stringify(pixKey)
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Unauthorized';
        return {
            statusCode: 401,
            body: JSON.stringify({ error: message })
        };
    }
};
exports.create = create;

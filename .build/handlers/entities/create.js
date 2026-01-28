"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.create = void 0;
const prisma_1 = require("@/lib/prisma");
const zod_1 = require("zod");
const authMiddleware_1 = require("@/middleware/authMiddleware");
const createEntitySchema = zod_1.z.object({
    name: zod_1.z.string(),
    document: zod_1.z.string()
});
const create = async (event) => {
    try {
        (0, authMiddleware_1.verifyToken)(event);
        const customerId = event.pathParameters?.id;
        if (!customerId) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Customer ID is required in path' })
            };
        }
        const body = JSON.parse(event.body || '{}');
        const parsed = createEntitySchema.safeParse(body);
        if (!parsed.success) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Invalid payload', details: parsed.error.flatten() })
            };
        }
        const { name, document } = parsed.data;
        const entity = await prisma_1.prisma.core_customer_entities.create({
            data: {
                name,
                document,
                customer_id: customerId
            }
        });
        return {
            statusCode: 201,
            body: JSON.stringify(entity)
        };
    }
    catch (error) {
        return {
            statusCode: 401,
            body: JSON.stringify({ error: error?.message || 'Unauthorized' })
        };
    }
};
exports.create = create;

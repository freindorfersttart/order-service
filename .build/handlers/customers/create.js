"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.create = void 0;
const prisma_1 = require("@/lib/prisma");
const zod_1 = require("zod");
const authMiddleware_1 = require("@/middleware/authMiddleware");
const createCustomerSchema = zod_1.z.object({
    type: zod_1.z.enum(['pf', 'pj']),
    name: zod_1.z.string(),
    document: zod_1.z.string(),
    email: zod_1.z.string().email().optional()
});
const create = async (event) => {
    try {
        // 🔐 Valida o token e extrai o userId
        const { userId } = (0, authMiddleware_1.verifyToken)(event);
        // ✅ Valida o payload
        const body = JSON.parse(event.body || '{}');
        const parsed = createCustomerSchema.safeParse(body);
        if (!parsed.success) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Invalid payload', details: parsed.error.flatten() })
            };
        }
        const { type, name, document, email } = parsed.data;
        const customer = await prisma_1.prisma.core_customers.create({
            data: { type, name, document, email }
        });
        return {
            statusCode: 201,
            body: JSON.stringify(customer)
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

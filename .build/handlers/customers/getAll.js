"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAll = void 0;
const prisma_1 = require("@/lib/prisma");
const authMiddleware_1 = require("@/middleware/authMiddleware");
const getAll = async (event) => {
    try {
        // Verifica token JWT
        (0, authMiddleware_1.verifyToken)(event);
        const customers = await prisma_1.prisma.core_customers.findMany({
            orderBy: { created_at: 'desc' },
            include: {
                entities: true,
                pix_keys: true
            }
        });
        return {
            statusCode: 200,
            body: JSON.stringify(customers)
        };
    }
    catch (error) {
        return {
            statusCode: 401,
            body: JSON.stringify({ error: error?.message || 'Unauthorized' })
        };
    }
};
exports.getAll = getAll;

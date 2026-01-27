"use strict";
// src/handlers/auth/me.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const authMiddleware_1 = require("../../middleware/authMiddleware");
const prisma_1 = require("../../lib/prisma");
const handler = async (event) => {
    try {
        const { userId } = (0, authMiddleware_1.verifyToken)(event);
        const user = await prisma_1.prisma.auth_user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                email: true,
                name: true,
                role: true,
                permissions: true,
                is_active: true,
                createdAt: true,
            },
        });
        if (!user) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Usuário não encontrado' }),
            };
        }
        return {
            statusCode: 200,
            body: JSON.stringify({ user }),
        };
    }
    catch (error) {
        return {
            statusCode: 401,
            body: JSON.stringify({ error: error.message || 'Não autorizado' }),
        };
    }
};
exports.handler = handler;

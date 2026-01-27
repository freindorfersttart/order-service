"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const prisma_1 = require("../../lib/prisma");
const jwt_1 = require("../../lib/jwt");
const handler = async (event) => {
    try {
        const userId = (0, jwt_1.getUserIdFromEvent)(event);
        // Apenas garante que o usuário está autenticado
        const user = await prisma_1.prisma.auth_user.findUnique({ where: { id: userId } });
        if (!user) {
            return {
                statusCode: 401,
                body: JSON.stringify({ message: 'Usuário não autenticado' }),
            };
        }
        // Retorna todos os usuários sem filtrar por role
        const users = await prisma_1.prisma.auth_user.findMany({
            select: {
                id: true,
                name: true,
                email: true,
                role: true,
                permissions: true,
                is_active: true,
                createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
        });
        return {
            statusCode: 200,
            body: JSON.stringify({ users }),
        };
    }
    catch (error) {
        console.error(error);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: 'Erro ao buscar usuários' }),
        };
    }
};
exports.handler = handler;

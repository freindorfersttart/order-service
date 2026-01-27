"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const prisma_1 = require("../../lib/prisma");
const handler = async () => {
    try {
        const workers = await prisma_1.prisma.core_workers.findMany({
            orderBy: { updated_at: 'desc' },
        });
        return {
            statusCode: 200,
            body: JSON.stringify(workers),
        };
    }
    catch (err) {
        console.error('Erro ao listar workers:', err);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: 'Erro interno ao listar os workers' }),
        };
    }
};
exports.handler = handler;

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAll = void 0;
const prisma_1 = require("@/lib/prisma");
const getAll = async () => {
    try {
        const accounts = await prisma_1.prisma.core_bank_accounts.findMany({
            orderBy: { created_at: 'desc' }
        });
        return {
            statusCode: 200,
            body: JSON.stringify(accounts)
        };
    }
    catch (err) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Erro ao buscar contas bancárias', message: err.message })
        };
    }
};
exports.getAll = getAll;

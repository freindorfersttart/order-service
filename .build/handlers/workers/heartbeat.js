"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const prisma_1 = require("../../lib/prisma");
const handler = async (event) => {
    try {
        const body = JSON.parse(event.body || '{}');
        const { workerId, status } = body;
        if (!workerId || !status) {
            return {
                statusCode: 400,
                body: JSON.stringify({ message: 'workerId e status são obrigatórios' }),
            };
        }
        await prisma_1.prisma.core_workers.update({
            where: { id: workerId },
            data: {
                status,
                last_checkin_at: new Date(),
            },
        });
        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Heartbeat registrado com sucesso' }),
        };
    }
    catch (err) {
        console.error(err);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: 'Erro interno no heartbeat' }),
        };
    }
};
exports.handler = handler;

import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { prisma } from '../../lib/prisma';
import { verifyToken } from '../../middleware/authMiddleware';

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    // 🔐 JWT
    verifyToken(event as any);

    const workerId = event.pathParameters?.id;
    if (!workerId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: 'workerId é obrigatório' }),
      };
    }

    if (!event.body) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: 'Body é obrigatório' }),
      };
    }

    const { is_active } = JSON.parse(event.body);

    if (typeof is_active !== 'boolean') {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: 'is_active deve ser boolean' }),
      };
    }

    const worker = await prisma.core_workers.update({
      where: { id: workerId },
      data: {
        is_active,
        status: is_active ? 'Online' : 'Disabled',
        updated_at: new Date(),
      },
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Worker atualizado com sucesso',
        worker,
      }),
    };
  } catch (error: any) {
    console.error('[updateWorkerStatus]', error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Erro interno ao atualizar worker',
        error: error.message,
      }),
    };
  }
};

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { prisma } from '../../lib/prisma';

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { workerId, status } = body;

    if (!workerId || !status) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: 'workerId e status são obrigatórios' }),
      };
    }

    await prisma.core_workers.update({
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
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Erro interno no heartbeat' }),
    };
  }
};

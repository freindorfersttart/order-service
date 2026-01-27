import { APIGatewayProxyHandler } from 'aws-lambda';
import { prisma } from '../../lib/prisma';

export const handler: APIGatewayProxyHandler = async () => {
  try {
    const workers = await prisma.core_workers.findMany({
      orderBy: { updated_at: 'desc' },
    });

    return {
      statusCode: 200,
      body: JSON.stringify(workers),
    };
  } catch (err) {
    console.error('Erro ao listar workers:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Erro interno ao listar os workers' }),
    };
  }
};

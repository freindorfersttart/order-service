import { APIGatewayProxyHandler } from 'aws-lambda'
import { prisma } from '@/lib/prisma'
import { verifyToken } from '@/middleware/authMiddleware'

export const getAll: APIGatewayProxyHandler = async (event) => {
  try {
    // Verifica token JWT
    verifyToken(event)

    const customers = await prisma.core_customers.findMany({
    orderBy: { created_at: 'desc' },
    include: {
        pix_keys: true, // pega as chaves do customer
        entities: {
        include: {
            pix_keys: true // pega as chaves das entidades
        }
        }
    }
    })

    return {
      statusCode: 200,
      body: JSON.stringify(customers)
    }

  } catch (error: any) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: error?.message || 'Unauthorized' })
    }
  }
}

import { APIGatewayProxyHandler } from 'aws-lambda'
import { prisma } from '@/lib/prisma'
import { z } from 'zod'
import { verifyToken } from '@/middleware/authMiddleware'

const createEntitySchema = z.object({
  name: z.string(),
  document: z.string()
})

export const create: APIGatewayProxyHandler = async (event) => {
  try {
    verifyToken(event)

    const customerId = event.pathParameters?.id
    if (!customerId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Customer ID is required in path' })
      }
    }

    const body = JSON.parse(event.body || '{}')
    const parsed = createEntitySchema.safeParse(body)

    if (!parsed.success) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid payload', details: parsed.error.flatten() })
      }
    }

    const { name, document } = parsed.data

    const entity = await prisma.core_customer_entities.create({
      data: {
        name,
        document,
        customer_id: customerId
      }
    })

    return {
      statusCode: 201,
      body: JSON.stringify(entity)
    }

  } catch (error: any) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: error?.message || 'Unauthorized' })
    }
  }
}

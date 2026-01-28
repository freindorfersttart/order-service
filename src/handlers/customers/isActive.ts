import { APIGatewayProxyHandler } from 'aws-lambda'
import { prisma } from '@/lib/prisma'
import { z } from 'zod'
import { verifyToken } from '@/middleware/authMiddleware'

const updateStatusSchema = z.object({
  is_active: z.boolean()
})

export const isActive: APIGatewayProxyHandler = async (event) => {
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
    const parsed = updateStatusSchema.safeParse(body)

    if (!parsed.success) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Invalid payload',
          details: parsed.error.flatten()
        })
      }
    }

    const { is_active } = parsed.data

    const updated = await prisma.core_customers.update({
      where: { id: customerId },
      data: { is_active }
    })

    return {
      statusCode: 200,
      body: JSON.stringify(updated)
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error'
    return {
      statusCode: 500,
      body: JSON.stringify({ error: message })
    }
  }
}

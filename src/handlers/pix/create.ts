import { APIGatewayProxyHandler } from 'aws-lambda'
import { prisma } from '@/lib/prisma'
import { z } from 'zod'
import { verifyToken } from '@/middleware/authMiddleware'

const createPixKeySchema = z.object({
  owner_type: z.enum(['customer', 'entity']),
  key_type: z.enum(['cpf', 'cnpj', 'email', 'phone', 'random']),
  key_value: z.string(),
  label: z.string().optional()
})

export const create: APIGatewayProxyHandler = async (event) => {
  try {
    verifyToken(event)

    const ownerId = event.pathParameters?.id
    if (!ownerId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Owner ID is required in path' })
      }
    }

    const body = JSON.parse(event.body || '{}')
    const parsed = createPixKeySchema.safeParse(body)

    if (!parsed.success) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Invalid payload',
          details: parsed.error.flatten()
        })
      }
    }

    const { owner_type, key_type, key_value, label } = parsed.data

    const pixKey = await prisma.core_pix_keys.create({
      data: {
        key_type,
        key_value,
        label,
        customer_id: owner_type === 'customer' ? ownerId : undefined,
        entity_id: owner_type === 'entity' ? ownerId : undefined
      }
    })

    return {
      statusCode: 201,
      body: JSON.stringify(pixKey)
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unauthorized'
    return {
      statusCode: 401,
      body: JSON.stringify({ error: message })
    }
  }
}

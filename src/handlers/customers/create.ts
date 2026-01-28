import { APIGatewayProxyHandler } from 'aws-lambda'
import { prisma } from '@/lib/prisma'
import { z } from 'zod'
import { verifyToken } from '@/middleware/authMiddleware'

const createCustomerSchema = z.object({
  type: z.enum(['pf', 'pj']),
  name: z.string(),
  document: z.string(),
  email: z.string().email().optional()
})

export const create: APIGatewayProxyHandler = async (event) => {
  try {
    // 🔐 Valida o token e extrai o userId
    const { userId } = verifyToken(event)

    // ✅ Valida o payload
    const body = JSON.parse(event.body || '{}')
    const parsed = createCustomerSchema.safeParse(body)

    if (!parsed.success) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid payload', details: parsed.error.flatten() })
      }
    }

    const { type, name, document, email } = parsed.data

    const customer = await prisma.core_customers.create({
      data: { type, name, document, email }
    })

    return {
      statusCode: 201,
      body: JSON.stringify(customer)
    }

} catch (error: any) {
  return {
    statusCode: 401,
    body: JSON.stringify({ error: error?.message || 'Unauthorized' })
  }
}
}

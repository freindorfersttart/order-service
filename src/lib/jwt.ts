import { APIGatewayProxyEvent } from 'aws-lambda'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'secret'

type JwtPayload = {
  userId: string
  email: string
  iat: number
  exp: number
}

export function getUserIdFromEvent(event: APIGatewayProxyEvent): string {
  const authHeader = event.headers.Authorization || event.headers.authorization

  if (!authHeader) {
    throw new Error('Token não fornecido')
  }

  const token = authHeader.replace('Bearer ', '')
  const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload

  if (!decoded.userId) {
    throw new Error('Token inválido: userId ausente')
  }

  return decoded.userId
}
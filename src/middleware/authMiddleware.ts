// src/middleware/authMiddleware.ts
import { APIGatewayProxyEvent } from 'aws-lambda';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'secret-jwt-sttart';

export function verifyToken(event: APIGatewayProxyEvent): { userId: string } {
  const authHeader = event.headers.Authorization || event.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Token ausente ou malformado');
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
    return decoded;
  } catch (error) {
    throw new Error('Token inválido');
  }
}

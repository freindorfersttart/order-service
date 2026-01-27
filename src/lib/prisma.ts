// src/lib/prisma.ts

import { PrismaClient } from '@prisma/client'; // ✅ certo agora

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'], // pode remover ou ajustar
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

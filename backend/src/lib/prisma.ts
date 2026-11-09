import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { env } from '../config/env';

// Reuse the local Prisma client across module reloads during development
const globalPrisma = globalThis as typeof globalThis & { summitThreadPrisma?: PrismaClient };
// Limit local database connections for this single-process demo
const adapter = new PrismaPg({ connectionString: env.DATABASE_URL, max: 5 });

// Share one configured Prisma client across backend features
export const prisma = globalPrisma.summitThreadPrisma ?? new PrismaClient({
  adapter,
  log: env.NODE_ENV === 'production' ? ['error'] : ['error']
});

if (env.NODE_ENV !== 'production') globalPrisma.summitThreadPrisma = prisma;

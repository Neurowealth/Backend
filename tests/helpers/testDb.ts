/**
 * testDb.ts — helpers for setting up and tearing down a test database,
 * plus a createMockDb() factory for unit/integration tests that should
 * not hit a real database.
 */

import { PrismaClient } from '@prisma/client';

let prisma: PrismaClient | null = null;

/**
 * Connect to the test database.
 * Requires DATABASE_URL to point at a test-only instance.
 */
export async function setupTestDatabase(): Promise<PrismaClient> {
  prisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  });
  await prisma.$connect();
  return prisma;
}

/**
 * Delete all rows from every table (reverse dependency order) and disconnect.
 */
export async function teardownTestDatabase(): Promise<void> {
  if (!prisma) return;
  await prisma.$transaction([
    prisma.agentLog.deleteMany(),
    prisma.yieldSnapshot.deleteMany(),
    prisma.transaction.deleteMany(),
    prisma.position.deleteMany(),
    prisma.session.deleteMany(),
    prisma.protocolRate.deleteMany(),
    prisma.user.deleteMany(),
  ]);
  await prisma.$disconnect();
  prisma = null;
}

/** Return the shared test client. Throws if not yet initialized. */
export function getTestDb(): PrismaClient {
  if (!prisma) {
    throw new Error('Test database not initialized. Call setupTestDatabase() first.');
  }
  return prisma;
}

/**
 * Return a fully-mocked Prisma client suitable for unit and integration tests
 * that must not touch a real database.
 */
export function createMockDb() {
  return {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
    session: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    position: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    transaction: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      upsert: jest.fn(),
      count: jest.fn(),
    },
    yieldSnapshot: {
      findMany: jest.fn(),
      create: jest.fn(),
    },
    protocolRate: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    },
    agentLog: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    },
    processedEvent: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    eventCursor: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    $transaction: jest.fn().mockImplementation((ops: Promise<unknown>[]) =>
      Promise.all(ops),
    ),
  };
}

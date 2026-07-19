/**
 * Jest configuration.
 *
 * Tests are TypeScript and rely on type-aware behaviour (type assertions, enum
 * imports from generated Prisma client), so they are transformed with ts-jest
 * rather than the babel-jest default — babel strips types without checking and
 * cannot parse constructs like `x as any`. tsconfig.test.json supplies the
 * compiler options (it extends the app tsconfig and adds the jest/node types).
 */
/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  clearMocks: true,
};

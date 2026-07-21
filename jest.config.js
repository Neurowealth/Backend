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
  // Must run before any test module so src/config/env.ts sees the test config
  // at import time. See tests/setup-env.ts.
  setupFiles: ['<rootDir>/tests/setup-env.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
    // @stellar/stellar-sdk's CJS build requires vendored @stellar/js-xdr
    // *source* files, which are ESM — transpile them so jest (CJS) can load them.
    '^.+\\.js$': ['ts-jest', { tsconfig: { allowJs: true } }],
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(@stellar|\\.pnpm|@noble|uint8array-extras|smol-toml|eventsource|feaxios|base32\\.js))',
  ],
  clearMocks: true,
};

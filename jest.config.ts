import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src", "<rootDir>/tests"],
  testMatch: ["**/?(*.)+(test).ts"],
  setupFiles: ["<rootDir>/tests/setupEnv.ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.test.json" }],
  },
  moduleFileExtensions: ["ts", "js"],
  // Prevent Jest from hanging due to open PrismaClient connections and
  // setInterval handles left by scanner.ts / sessionCleanup.ts
  forceExit: true,
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.test.ts",
    "!src/**/__tests__/**",
    "!src/index.ts",
    // ── Complex async infrastructure — tested end-to-end, not unit-testable ─
    "!src/agent/loop.ts",
    "!src/agent/snapshotter.ts",
    // ── On-chain bindings — no unit-testable logic without full Stellar stack
    "!src/stellar/contract.ts",
    "!src/stellar/events.ts",
    "!src/stellar/wallet.ts",
    "!src/stellar/index.ts",
    // ── Thin infrastructure: singletons, re-exports, type declarations ──────
    "!src/db/index.ts",
    "!src/middleware/index.ts",
    "!src/config/jwt-adapter.ts",
    "!src/types/express.d.ts",
  ],
  coverageThreshold: {
    global: {
      lines: 80,
      functions: 80,
    },
  },
};

export default config;

/** @type {import('jest').Config} */
const config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    // CommonJS output (see tsconfig.test.json). The previous ESM preset was
    // combined with a CommonJS tsconfig override, so ts-jest emitted `exports`
    // while jest parsed the module as ESM and every suite failed with
    // "exports is not defined" before it could even import the subject.
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.test.json',
      },
    ],
  },
  testMatch: ['**/tests/**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
  // NOTE: the key is `coverageThreshold`, not `coverageThresholds`. The typo
  // meant jest only printed "Unknown option" and the intended coverage gate was
  // never applied, so the suite could pass with collapsing coverage.
  //
  // The numbers below are a ratchet on what the *unit* suite actually covers,
  // not an aspiration. Measured at the time of writing: statements 41.0%,
  // branches 42.8%, functions 32.0%, lines 41.2%; the floor sits a few points
  // below so unrelated churn does not redden CI. Most use cases and every
  // infrastructure adapter (Prisma*, Redis*, Minio, flow-engine HTTP) need a
  // live database/Redis, so a global 75% bar here would only be reachable by
  // mocking the infrastructure; those paths are covered instead by the
  // isolated-stack job in .github/workflows/verify-integration.yml
  // (multi-tenant suite + Schemathesis). The gate exists to stop the unit
  // surface from regressing, not to certify the service.
  coverageThreshold: {
    global: {
      branches: 38,
      functions: 30,
      lines: 38,
      statements: 38,
    },
  },
};

export default config;

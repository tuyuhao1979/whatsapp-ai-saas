/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    // Strip .js extensions from imports so ts-jest can resolve .ts files
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    // CommonJS output (see tsconfig.test.json). The previous ESM preset was
    // combined with a CommonJS tsconfig override, so ts-jest emitted `exports`
    // while jest parsed the module as ESM and every suite failed with
    // "exports is not defined" before it could import its subject.
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.test.json',
      },
    ],
  },
  testMatch: ['**/tests/**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/main.ts',
  ],
  // A ratchet on the measured floor (statements 58.2%, branches 59.0%,
  // functions 58.3%, lines 58.6% at the time of writing), allowing a few points
  // of slack so unrelated churn does not redden CI. The infrastructure adapters
  // (pg pool, Redis cache/queue) need live services and are exercised by the
  // isolated-stack job instead.
  //
  // Deliberately no path-keyed entries here: mixing a `./src/...` key with
  // `global` made jest evaluate the global threshold against a different file
  // set in CI than the one printed in the table (it reported 50.4% statements
  // against a 58.2% table). The application-layer 80% gate lives in the
  // workflow instead, scoped with --collectCoverageFrom.
  coverageThreshold: {
    global: {
      branches: 55,
      functions: 55,
      lines: 55,
      statements: 55,
    },
  },
};

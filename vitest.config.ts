import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'test/**/*.test.ts',
      // The corpus harness computes the false positive rate S8 exists to produce, so it
      // is held to the same standard as the product rather than living in a script.
      'corpus/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'packages/*/test/**/*.test.ts',
      'fixtures/*/src/**/*.test.ts',
      'fixtures/*/test/**/*.test.ts',
    ],
    /**
     * A `.db.test.ts` needs a real Postgres and is not part of the default run.
     *
     * Rule R9 as amended by A7 permits a test to depend on a service this repository
     * starts and owns, and the tenant boundary is a row level security policy, which is a
     * Postgres feature that cannot be simulated in SQLite or mocked into meaning anything.
     * Those tests run under `packages/server/vitest.config.ts` against the compose service
     * or the CI service container, so a developer without a database gets a suite that
     * passes honestly rather than one that silently skips its most important assertion.
     */
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.db.test.ts'],
    environment: 'node',
    // R9: tests never touch the network, so nothing here should be slow enough
    // to need a raised timeout. A test that hits this limit is doing the wrong thing.
    testTimeout: 10_000,
  },
});

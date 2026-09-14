import { defineConfig } from 'vitest/config';

/**
 * The tests that need a real Postgres.
 *
 * Kept separate from the default run rather than skipped inside it. A skipped test reports
 * as a pass, and the assertion this file exists for is invariant I9, the one the plan calls
 * unrecoverable if absent. A developer with no database should see that these did not run,
 * not see a green suite that quietly omitted them.
 *
 * Bring the database up with `docker compose up -d` from the repository root, or let CI's
 * service container provide it. `DATABASE_URL` selects which.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.db.test.ts'],
    environment: 'node',
    // A container accepting its first connection is slower than anything in the default
    // suite, and the setup waits on readiness rather than on a sleep.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Row level security is session state on a connection. Running these files in parallel
    // against one database would let one test's session variable decide another's rows.
    fileParallelism: false,
  },
});

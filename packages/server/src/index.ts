/**
 * The control plane. Owns records, owns no execution.
 *
 * **This package does not import `core`, and a lint rule stops it.** Rule R14, asserted by
 * `test/import-boundaries.test.ts`. The control plane must never be able to run a check,
 * because a code path that can is a code path that will eventually be asked to. Everything
 * it needs to understand about a run arrives as data validated against `contracts`.
 *
 * Nothing here talks to a database yet. P3.1 through P3.3 need a real Postgres, because the
 * tenant boundary is a row level security policy and that is not a thing SQLite has or a
 * mock can stand in for. See this module's open questions.
 */
export {
  CAPABILITIES,
  ROLES,
  atLeast,
  can,
  capabilitiesOf,
  isRole,
  roleFor,
} from './tenancy/roles.ts';
export type { Capability, Membership, Role } from './tenancy/roles.ts';
export { TENANT_SETTING, closeDatabase, migrate, withTenant } from './tenancy/db.ts';
export type { Principal, Sql, TenantContext, Tx } from './tenancy/db.ts';
export {
  RunnerAuthError,
  hashSecret,
  issueRunnerJwt,
  registerRunner,
  revokeRunner,
  splitToken,
  verifyRunnerJwt,
  verifyRunnerToken,
} from './identity/runner.ts';
export type { RunnerCredential, RunnerRefusal, RunnerRegistration } from './identity/runner.ts';

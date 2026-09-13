import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';

import type { Role } from './roles.ts';

/**
 * The tenant boundary, enforced by the database.
 *
 * **Invariant I9.** Every tenant scoped table carries a row level security policy, so a
 * query missing its organization predicate is an error rather than a leak. A product whose
 * premise is that generated code silently omits authorization checks cannot have its own
 * isolation depend on the application layer being perfect.
 *
 * **`withTenant` is the only way to obtain a transaction, and that is the whole design.**
 * There is deliberately no unscoped accessor exported from this module, because an accessor
 * that exists is an accessor that gets used at 2am by somebody debugging something else.
 * Migrations are the one exception and run through `migrate`, which is a deploy time path
 * rather than a request handling one.
 */

/**
 * The authenticated entity a request acts as.
 *
 * **Not called an actor, and the naming is load bearing.** In this codebase an actor is a
 * configured identity used to interact with a *target*, which is a property of the customer's
 * application under inspection. A person logging in to the control plane is a different kind
 * of thing entirely. The module file's Do Not list forbids the reuse by name; its own Public
 * API sketch then uses `actor` for exactly that, which is a contradiction inside one
 * document. The prohibition is the deliberate half, since it states its reasoning, so this
 * follows it and calls the product's authenticated entity a principal.
 */
export interface Principal {
  readonly kind: 'user' | 'runner';
  readonly id: string;
  readonly role: Role;
}

export interface TenantContext {
  /** `ORG-` identifier. Every policy predicate compares against this. */
  readonly organization: string;
  readonly principal: Principal;
}

/** The session variable every policy in `0001_tenancy.sql` reads. */
export const TENANT_SETTING = 'specgate.organization_id';

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

let client: Sql | undefined;

/**
 * The connection, made once.
 *
 * Module private on purpose. Exporting it would be exporting the unscoped accessor this
 * design exists to not have.
 */
function connection(): Sql {
  if (client !== undefined) return client;

  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is not set. Bring a database up with "docker compose up -d" from the repository root, or let CI provide its service container.',
    );
  }

  client = postgres(url, { max: 8, onnotice: () => {} });
  return client;
}

/** Closes the pool. For a test teardown or a shutdown, never for a request. */
export async function closeDatabase(): Promise<void> {
  if (client === undefined) return;
  await client.end({ timeout: 5 });
  client = undefined;
}

/**
 * Runs `fn` inside a transaction scoped to one organization.
 *
 * The setting is written with `set_config(..., true)`, which is transaction local. That
 * matters more than it looks: the connection is pooled, so a session level setting would
 * outlive the transaction and hand the next borrower of that connection a tenant context it
 * never asked for. Transaction local means the scope ends when the transaction does,
 * whichever way it ends.
 */
export async function withTenant<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return connection().begin(async (tx) => {
    await tx`select set_config(${TENANT_SETTING}, ${ctx.organization}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

/**
 * Applies every migration, in filename order.
 *
 * The privileged path the module's Do Not list carves out. It is not a general accessor and
 * it is not reachable from request handling: nothing in a handler imports this, and the
 * boundary that keeps it that way is that no unscoped transaction helper is exported at all.
 */
export async function migrate(): Promise<readonly string[]> {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const sql = connection();
  for (const name of files) {
    await sql.unsafe(readFileSync(join(dir, name), 'utf8'));
  }
  return files;
}

/** Drops everything this schema owns. Test teardown only. */
export async function resetSchema(): Promise<void> {
  const sql = connection();
  await sql.unsafe('drop schema public cascade; create schema public;');
}

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TENANT_SETTING, closeDatabase, migrate, resetSchema, withTenant } from './db.ts';
import type { TenantContext } from './db.ts';

/**
 * Invariant I9, proven rather than asserted.
 *
 * **Why this needs a real Postgres.** Row level security is a database feature. There is no
 * SQLite equivalent and a mock of it tests the mock. This is the invariant the module file
 * calls unrecoverable if absent, so the one thing worse than not having this test is having
 * a version of it that passes without a database behind it.
 *
 * **Tables are enumerated from the catalog, never from a list in this file.** A hand written
 * list is a list somebody forgets to extend, and the failure mode is a new table shipping
 * with no policy and nothing saying so. Asking the database what tables exist means a table
 * added in a later migration fails here until it carries a policy.
 */

const ORG_A = 'ORG-aaaaaa';
const ORG_B = 'ORG-bbbbbb';

const asA: TenantContext = {
  organization: ORG_A,
  principal: { kind: 'user', id: 'USR-a', role: 'owner' },
};
const asB: TenantContext = {
  organization: ORG_B,
  principal: { kind: 'user', id: 'USR-b', role: 'owner' },
};

/** Seeded inside each tenant's own context, which also proves the WITH CHECK half. */
async function seed(ctx: TenantContext, suffix: string): Promise<void> {
  await withTenant(ctx, async (tx) => {
    await tx`insert into organizations (id, name) values (${ctx.organization}, ${'org ' + suffix})`;
    await tx`insert into projects (id, organization_id, name)
             values (${'PRJ-' + suffix}, ${ctx.organization}, ${'project ' + suffix})`;
    await tx`insert into environments (id, organization_id, project_id, name)
             values (${'ENV-' + suffix}, ${ctx.organization}, ${'PRJ-' + suffix}, 'production')`;
    await tx`insert into runners (id, organization_id, project_id, name, token_hash)
             values (${'RNR-' + suffix}, ${ctx.organization}, ${'PRJ-' + suffix}, 'ci', ${'hash-' + suffix})`;
    await tx`insert into activity (id, organization_id, action)
             values (${'ACT-' + suffix}, ${ctx.organization}, 'project.created')`;
  });
}

beforeAll(async () => {
  await resetSchema();
  await migrate();
  await seed(asA, 'aaaaaa');
  await seed(asB, 'bbbbbb');
}, 30_000);

afterAll(async () => {
  await closeDatabase();
});

/** Every base table in the public schema, asked of the database rather than declared here. */
async function tenantTables(): Promise<string[]> {
  return withTenant(asA, async (tx) => {
    const rows = await tx<{ tablename: string }[]>`
      select tablename from pg_tables where schemaname = 'public' order by tablename
    `;
    return rows.map((row) => row.tablename);
  });
}

describe('every tenant scoped table is protected by the database', () => {
  it('found the tables by asking the catalog', async () => {
    // If this ever returns nothing, every assertion below would pass vacuously.
    const tables = await tenantTables();
    expect(tables.length).toBeGreaterThanOrEqual(5);
    expect(tables).toContain('organizations');
    expect(tables).toContain('runners');
  });

  it('has row level security enabled and forced on every one of them', async () => {
    // FORCE is the half that is easy to miss. Plain ENABLE does not apply to the table
    // owner, and the application user owns these tables in both compose and CI, so without
    // FORCE every policy is inert while this suite still connects happily.
    const rows = await withTenant(asA, async (tx) => {
      return tx<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        select c.relname, c.relrowsecurity, c.relforcerowsecurity
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
        order by c.relname
      `;
    });

    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} has row level security enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} forces it on the owner too`).toBe(true);
    }
  });

  it('carries at least one policy on every one of them', async () => {
    const [tables, policies] = await withTenant(asA, async (tx) => {
      const t = await tx<{ tablename: string }[]>`
        select tablename from pg_tables where schemaname = 'public'
      `;
      const p = await tx<{ tablename: string }[]>`
        select tablename from pg_policies where schemaname = 'public'
      `;
      return [t.map((r) => r.tablename), new Set(p.map((r) => r.tablename))] as const;
    });

    for (const table of tables) {
      expect(policies.has(table), `${table} has a row level security policy`).toBe(true);
    }
  });
});

describe('the role requests connect as', () => {
  it('is neither a superuser nor able to bypass row level security', async () => {
    // The guard on the hole that made the first CI run of this schema return rows from both
    // organizations to a session with no tenant context. FORCE ROW LEVEL SECURITY covers
    // the table owner and says nothing about BYPASSRLS, which every superuser holds
    // implicitly. Asserting the privilege directly means a future change that connects as
    // the owner again fails here rather than silently disabling every policy.
    const rows = await withTenant(asA, async (tx) => {
      return tx<{ rolsuper: boolean; rolbypassrls: boolean; current_user: string }[]>`
        select r.rolsuper, r.rolbypassrls, current_user
        from pg_roles r where r.rolname = current_user
      `;
    });

    expect(rows[0]?.current_user).toBe('specgate_app');
    expect(rows[0]?.rolsuper, 'the request role is not a superuser').toBe(false);
    expect(rows[0]?.rolbypassrls, 'the request role cannot bypass row level security').toBe(false);
  });

  it('does not own the tables it queries', async () => {
    // Ownership plus FORCE would still be enforced, but not owning them means one fewer
    // way for a policy to be bypassed by accident.
    const rows = await withTenant(asA, async (tx) => {
      return tx<{ tableowner: string }[]>`
        select tableowner from pg_tables where schemaname = 'public'
      `;
    });
    for (const row of rows) {
      expect(row.tableowner).not.toBe('specgate_app');
    }
  });
});

describe('one organization cannot see another', () => {
  it('reads zero rows of B from every tenant scoped table while scoped to A', async () => {
    // The stage exit criterion, and deliberately a SELECT with no organization predicate:
    // the point is that the application forgetting the predicate is not a leak.
    const counts = await withTenant(asA, async (tx) => {
      return {
        organizations: await tx`select id from organizations`,
        projects: await tx`select id from projects`,
        environments: await tx`select id from environments`,
        runners: await tx`select id from runners`,
        activity: await tx`select id from activity`,
      };
    });

    for (const [table, rows] of Object.entries(counts)) {
      const ids = (rows as unknown as { id: string }[]).map((row) => row.id);
      expect(ids.length, `${table} returned only A's rows`).toBe(1);
      expect(
        ids.every((id) => id.endsWith('aaaaaa')),
        `${table} leaked a B row`,
      ).toBe(true);
    }
  });

  it('sees the mirror image from B', async () => {
    // Both directions, so a policy that happens to match one organization by accident does
    // not pass as isolation.
    const rows = await withTenant(asB, async (tx) => tx<{ id: string }[]>`select id from projects`);
    expect(rows.map((row) => row.id)).toStrictEqual(['PRJ-bbbbbb']);
  });

  it('refuses to write a row belonging to another organization', async () => {
    // WITH CHECK, not just USING. Reading is isolated above; this is the other half.
    await expect(
      withTenant(asA, async (tx) => {
        await tx`insert into projects (id, organization_id, name)
                 values ('PRJ-smuggled', ${ORG_B}, 'not mine')`;
      }),
    ).rejects.toThrow();
  });

  it('cannot reach another organization by updating a row into it', async () => {
    await expect(
      withTenant(asA, async (tx) => {
        await tx`update projects set organization_id = ${ORG_B} where id = 'PRJ-aaaaaa'`;
      }),
    ).rejects.toThrow();
  });
});

describe('a query with no tenant context', () => {
  it('errors rather than returning everything', async () => {
    // Opened raw on purpose. The product exports no unscoped accessor, which is the point
    // of the design, so proving what happens without one requires the test to make its own
    // connection rather than the module offering a way in.
    // The app role, not the owner. Connecting as the owner is what made the first run of
    // this suite pass a query that should have been impossible.
    const url = process.env['DATABASE_APP_URL'];
    expect(url, 'DATABASE_APP_URL is set for this suite').toBeDefined();
    const raw = postgres(url as string, { max: 1, onnotice: () => {} });

    try {
      // `current_setting` without the missing_ok argument raises when the variable is
      // unset. The two argument form would return NULL, the predicate would be NULL, and
      // this would quietly return zero rows: a safe answer that looks identical to an
      // empty organization and hides the bug.
      await expect(raw`select id from projects`).rejects.toThrow(
        /unrecognized configuration parameter|specgate\.organization_id/i,
      );

      // And the setting really is absent rather than left behind by a pooled connection.
      const leaked = await raw`select current_setting(${TENANT_SETTING}, true) as value`;
      expect(leaked[0]?.['value'] ?? null).toBeNull();
    } finally {
      await raw.end({ timeout: 5 });
    }
  });
});

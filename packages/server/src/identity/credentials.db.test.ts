import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase, migrate, resetSchema, withTenant } from '../tenancy/db.ts';
import type { TenantContext } from '../tenancy/db.ts';
import { putActor, recordResolution, unresolvedActors } from './credentials.ts';

/**
 * Actor credential references and the health signal, against the real tenant boundary.
 *
 * The assertion worth having is the last one: no column of this table ever holds a
 * credential value. The rest is storage, and storage that leaks a secret is the failure this
 * product exists to notice in other people's software.
 */

const AT = new Date(Date.UTC(2026, 8, 13, 12, 0, 0));

const asA: TenantContext = {
  organization: 'ORG-aaaaaa',
  principal: { kind: 'user', id: 'USR-a', role: 'owner' },
};
const asB: TenantContext = {
  organization: 'ORG-bbbbbb',
  principal: { kind: 'user', id: 'USR-b', role: 'owner' },
};

beforeAll(async () => {
  await resetSchema();
  await migrate();

  for (const [ctx, suffix] of [
    [asA, 'aaaaaa'],
    [asB, 'bbbbbb'],
  ] as const) {
    await withTenant(ctx, async (tx) => {
      await tx`insert into organizations (id, name) values (${ctx.organization}, ${'org ' + suffix})`;
      await tx`insert into projects (id, organization_id, name)
               values (${'PRJ-' + suffix}, ${ctx.organization}, ${'project ' + suffix})`;
      await tx`insert into environments (id, organization_id, project_id, name)
               values (${'ENV-' + suffix}, ${ctx.organization}, ${'PRJ-' + suffix}, 'production')`;
    });
  }
}, 30_000);

afterAll(async () => {
  await closeDatabase();
});

describe('recording where a credential lives', () => {
  it('stores the reference and refuses the value', async () => {
    await putActor(
      {
        id: 'ACTR-1',
        environmentId: 'ENV-aaaaaa',
        actorId: 'owner',
        credential: { kind: 'env', ref: 'LEDGER_OWNER_TOKEN' },
      },
      asA,
    );

    await expect(
      putActor(
        {
          id: 'ACTR-bad',
          environmentId: 'ENV-aaaaaa',
          actorId: 'leaky',
          credential: { kind: 'env', ref: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
        },
        asA,
      ),
    ).rejects.toThrow(/value rather than a reference/i);
  });

  it('updates a reference in place rather than accumulating rows', async () => {
    await putActor(
      {
        id: 'ACTR-1',
        environmentId: 'ENV-aaaaaa',
        actorId: 'owner',
        credential: { kind: 'vault', ref: 'secret/data/ledger#owner' },
      },
      asA,
    );

    const rows = await withTenant(asA, async (tx) => {
      return tx<{ ref_kind: string; ref: string }[]>`
        select ref_kind, ref from environment_actors where actor_id = 'owner'
      `;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ref_kind).toBe('vault');
  });
});

describe('the health signal', () => {
  it('reports an actor that has never resolved', async () => {
    // The failure mode the whole product exists to prevent, done to ourselves: a run that
    // established almost nothing while still exiting zero.
    const health = await unresolvedActors('ENV-aaaaaa', asA);
    expect(health.map((one) => one.actorId)).toContain('owner');
    expect(health[0]?.neverResolved).toBe(true);
  });

  it('clears once a run reports the credential resolved', async () => {
    await recordResolution(
      { environmentId: 'ENV-aaaaaa', actorId: 'owner', resolved: true },
      AT,
      asA,
    );
    expect(await unresolvedActors('ENV-aaaaaa', asA)).toHaveLength(0);
  });

  it('returns with the reason when a run reports a failure', async () => {
    await recordResolution(
      {
        environmentId: 'ENV-aaaaaa',
        actorId: 'owner',
        resolved: false,
        failure: 'LEDGER_OWNER_TOKEN is not set on the runner',
      },
      AT,
      asA,
    );

    const [health] = await unresolvedActors('ENV-aaaaaa', asA);
    expect(health?.failure).toMatch(/not set on the runner/);
    expect(health?.ref).toBe('secret/data/ledger#owner');
  });

  it('shows one organization nothing about another', async () => {
    await putActor(
      {
        id: 'ACTR-2',
        environmentId: 'ENV-bbbbbb',
        actorId: 'theirs',
        credential: { kind: 'env', ref: 'THEIR_TOKEN' },
      },
      asB,
    );
    const health = await unresolvedActors('ENV-bbbbbb', asA);
    expect(health).toHaveLength(0);
  });
});

describe('no column holds a credential value', () => {
  it('finds nothing secret shaped anywhere in the table', async () => {
    // Asserted by looking, not by trusting the writer. The module's Definition of Done asks
    // for exactly this and says "and by review", which is the half a test cannot do.
    const rows = await withTenant(asA, async (tx) => {
      return tx<Record<string, unknown>[]>`select * from environment_actors`;
    });

    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (typeof value !== 'string') continue;
        expect(value).not.toMatch(/^(gh[pousr]_|xox[baprs]-|sk-|AKIA|eyJ)/);
        expect(value.length).toBeLessThanOrEqual(120);
      }
    }
  });
});

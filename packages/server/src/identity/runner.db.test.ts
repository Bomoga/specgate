import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase, migrate, resetSchema, withTenant } from '../tenancy/db.ts';
import type { TenantContext } from '../tenancy/db.ts';
import { registerRunner, revokeRunner, verifyRunnerToken } from './runner.ts';

/**
 * Registration, verification, and revocation, against the real tenant boundary.
 *
 * The interesting assertions here are the ones about what a token cannot reach. A credential
 * is only useful if presenting it proves membership of exactly one organization, and row
 * level security is what makes that structural rather than a check somebody remembered.
 */

const asA: TenantContext = {
  organization: 'ORG-aaaaaa',
  principal: { kind: 'user', id: 'USR-a', role: 'owner' },
};
const asB: TenantContext = {
  organization: 'ORG-bbbbbb',
  principal: { kind: 'user', id: 'USR-b', role: 'owner' },
};

async function seedOrg(ctx: TenantContext, suffix: string): Promise<void> {
  await withTenant(ctx, async (tx) => {
    await tx`insert into organizations (id, name) values (${ctx.organization}, ${'org ' + suffix})`;
    await tx`insert into projects (id, organization_id, name)
             values (${'PRJ-' + suffix}, ${ctx.organization}, ${'project ' + suffix})`;
  });
}

beforeAll(async () => {
  await resetSchema();
  await migrate();
  await seedOrg(asA, 'aaaaaa');
  await seedOrg(asB, 'bbbbbb');
}, 30_000);

afterAll(async () => {
  await closeDatabase();
});

describe('registering a runner', () => {
  it('returns a token once and stores only a hash of it', async () => {
    const credential = await registerRunner(
      { runnerId: 'RNR-store', projectId: 'PRJ-aaaaaa', name: 'ci' },
      asA,
    );

    const [row] = await withTenant(asA, async (tx) => {
      return tx<{ token_hash: string }[]>`
        select token_hash from runners where id = 'RNR-store'
      `;
    });

    // No credential value appears in any table, under any framing.
    const secret = credential.token.split('.').slice(1).join('.');
    expect(row?.token_hash).toBeDefined();
    expect(row?.token_hash).not.toBe(secret);
    expect(row?.token_hash).not.toContain(secret);
  });

  it('verifies the token it just issued', async () => {
    const credential = await registerRunner(
      { runnerId: 'RNR-verify', projectId: 'PRJ-aaaaaa', name: 'ci' },
      asA,
    );
    const ctx = await verifyRunnerToken(credential.token);
    expect(ctx.organization).toBe('ORG-aaaaaa');
    expect(ctx.principal.id).toBe('RNR-verify');
    expect(ctx.principal.kind).toBe('runner');
  });
});

describe('a token cannot reach another organization', () => {
  it('refuses a secret presented with a different organization prefix', async () => {
    // The prefix is not trusted. It scopes the lookup, and the secret still has to match a
    // row that exists inside that organization, which it does not.
    const credential = await registerRunner(
      { runnerId: 'RNR-scoped', projectId: 'PRJ-aaaaaa', name: 'ci' },
      asA,
    );
    const secret = credential.token.split('.').slice(1).join('.');
    await expect(verifyRunnerToken(`ORG-bbbbbb.${secret}`)).rejects.toThrow(/no runner/i);
  });

  it('refuses a secret that was never issued', async () => {
    await expect(verifyRunnerToken('ORG-aaaaaa.not-a-real-secret')).rejects.toThrow(/no runner/i);
  });

  it('refuses a malformed token before touching the database', async () => {
    await expect(verifyRunnerToken('no-separator')).rejects.toThrow(/organization and a secret/i);
  });
});

describe('revocation', () => {
  it('refuses a revoked token, which the exit criterion asks for by name', async () => {
    const credential = await registerRunner(
      { runnerId: 'RNR-revoked', projectId: 'PRJ-aaaaaa', name: 'ci' },
      asA,
    );
    await expect(verifyRunnerToken(credential.token)).resolves.toBeDefined();

    expect(await revokeRunner('RNR-revoked', asA)).toBe(true);
    await expect(verifyRunnerToken(credential.token)).rejects.toThrow(/revoked/i);
  });

  it('revokes one runner and leaves the others alone', async () => {
    // Individual revocation, per the module. Revoking everything for a project would be a
    // different and much blunter feature.
    const keep = await registerRunner(
      { runnerId: 'RNR-keep', projectId: 'PRJ-aaaaaa', name: 'keep' },
      asA,
    );
    const drop = await registerRunner(
      { runnerId: 'RNR-drop', projectId: 'PRJ-aaaaaa', name: 'drop' },
      asA,
    );

    await revokeRunner('RNR-drop', asA);
    await expect(verifyRunnerToken(drop.token)).rejects.toThrow(/revoked/i);
    await expect(verifyRunnerToken(keep.token)).resolves.toBeDefined();
  });

  it('cannot revoke a runner belonging to another organization', async () => {
    const credential = await registerRunner(
      { runnerId: 'RNR-theirs', projectId: 'PRJ-bbbbbb', name: 'ci' },
      asB,
    );

    // B's runner is invisible to A, so the update matches nothing rather than being refused
    // by an application check that somebody could forget to write.
    expect(await revokeRunner('RNR-theirs', asA)).toBe(false);
    await expect(verifyRunnerToken(credential.token)).resolves.toBeDefined();
  });

  it('reports a second revocation as a no-op', async () => {
    await registerRunner({ runnerId: 'RNR-twice', projectId: 'PRJ-aaaaaa', name: 'ci' }, asA);
    expect(await revokeRunner('RNR-twice', asA)).toBe(true);
    expect(await revokeRunner('RNR-twice', asA)).toBe(false);
  });
});

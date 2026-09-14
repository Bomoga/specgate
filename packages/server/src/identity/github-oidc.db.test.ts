import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase, migrate, resetSchema, withTenant } from '../tenancy/db.ts';
import type { TenantContext } from '../tenancy/db.ts';
import { GITHUB_ISSUER, mapRepository, verifyGithubOidc } from './github-oidc.ts';
import type { JsonWebKey } from './github-oidc.ts';

/**
 * GitHub OIDC, tested against a keypair this file generates.
 *
 * Rule R9 says a test never touches the network, and verifying an OIDC token really means
 * fetching GitHub's published keys. The key set is a parameter for that reason, so these
 * tests sign tokens with their own key and exercise the same code path production does,
 * rather than a branch that only runs under test.
 */

const AUDIENCE = 'https://specgate.example';
const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);
const KID = 'test-key-1';

let privateKey: KeyObject;
let keys: JsonWebKey[];

const asA: TenantContext = {
  organization: 'ORG-aaaaaa',
  principal: { kind: 'user', id: 'USR-a', role: 'owner' },
};
const asB: TenantContext = {
  organization: 'ORG-bbbbbb',
  principal: { kind: 'user', id: 'USR-b', role: 'owner' },
};

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** Mints a token the way GitHub would, so the test can vary one claim at a time. */
function mint(
  claims: Record<string, unknown>,
  options: { alg?: string; kid?: string } = {},
): string {
  const head = b64({ alg: options.alg ?? 'RS256', kid: options.kid ?? KID, typ: 'JWT' });
  const body = b64({
    iss: GITHUB_ISSUER,
    aud: AUDIENCE,
    exp: Math.floor(NOW / 1000) + 300,
    repository: 'Bomoga/specgate',
    sub: 'repo:Bomoga/specgate:ref:refs/heads/dev',
    ...claims,
  });
  const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey);
  return `${head}.${body}.${signature.toString('base64url')}`;
}

beforeAll(async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  const jwk = pair.publicKey.export({ format: 'jwk' }) as unknown as JsonWebKey;
  keys = [{ ...jwk, kid: KID, alg: 'RS256' }];

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
    });
  }

  await mapRepository({ id: 'GHR-1', projectId: 'PRJ-aaaaaa', repository: 'Bomoga/specgate' }, asA);
}, 30_000);

afterAll(async () => {
  await closeDatabase();
});

const scopeA = { organization: 'ORG-aaaaaa', project: 'PRJ-aaaaaa', audience: AUDIENCE };

describe('a valid token from a registered repository', () => {
  it('authorizes the project it is mapped to', async () => {
    const ctx = await verifyGithubOidc(mint({}), scopeA, keys, NOW);
    expect(ctx.organization).toBe('ORG-aaaaaa');
    expect(ctx.principal.kind).toBe('runner');
    expect(ctx.principal.id).toBe('github:Bomoga/specgate');
  });

  it('holds no administrative capability', async () => {
    // A runner submits runs. It is not a person and must not be able to change membership.
    const ctx = await verifyGithubOidc(mint({}), scopeA, keys, NOW);
    expect(ctx.principal.role).toBe('member');
  });
});

describe('what the signature check refuses', () => {
  it('refuses a token signed by an unpublished key', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const saved = privateKey;
    privateKey = other.privateKey;
    try {
      await expect(verifyGithubOidc(mint({}), scopeA, keys, NOW)).rejects.toThrow(/signature/i);
    } finally {
      privateKey = saved;
    }
  });

  it('refuses a key id that is not in the published set', async () => {
    await expect(
      verifyGithubOidc(mint({}, { kid: 'not-published' }), scopeA, keys, NOW),
    ).rejects.toThrow(/no published key/i);
  });

  it('refuses an algorithm that is not RS256', async () => {
    // Accepting an HMAC algorithm here would let a caller sign with the public key as
    // though it were a shared secret.
    await expect(verifyGithubOidc(mint({}, { alg: 'HS256' }), scopeA, keys, NOW)).rejects.toThrow(
      /RS256/i,
    );
    await expect(verifyGithubOidc(mint({}, { alg: 'none' }), scopeA, keys, NOW)).rejects.toThrow(
      /RS256/i,
    );
  });
});

describe('what the claim checks refuse', () => {
  it('refuses another issuer', async () => {
    await expect(
      verifyGithubOidc(mint({ iss: 'https://evil.example' }), scopeA, keys, NOW),
    ).rejects.toThrow(/not issued by GitHub/i);
  });

  it('refuses a token minted for a different audience', async () => {
    // A valid GitHub token somebody else was given. The signature is real and it is still
    // not for this service.
    await expect(
      verifyGithubOidc(mint({ aud: 'https://someone-else.example' }), scopeA, keys, NOW),
    ).rejects.toThrow(/different audience/i);
  });

  it('accepts an audience array containing ours', async () => {
    const token = mint({ aud: ['https://other.example', AUDIENCE] });
    await expect(verifyGithubOidc(token, scopeA, keys, NOW)).resolves.toBeDefined();
  });

  it('refuses an expired token', async () => {
    const token = mint({ exp: Math.floor(NOW / 1000) - 1 });
    await expect(verifyGithubOidc(token, scopeA, keys, NOW)).rejects.toThrow(/expired/i);
  });

  it('refuses one that is not valid yet', async () => {
    const token = mint({ nbf: Math.floor(NOW / 1000) + 60 });
    await expect(verifyGithubOidc(token, scopeA, keys, NOW)).rejects.toThrow(/not valid yet/i);
  });
});

describe('the repository mapping', () => {
  it('refuses a repository nobody registered', async () => {
    const token = mint({ repository: 'Bomoga/not-registered' });
    await expect(verifyGithubOidc(token, scopeA, keys, NOW)).rejects.toThrow(/not registered/i);
  });

  it('refuses a registered repository aimed at a different project', async () => {
    const scope = { ...scopeA, project: 'PRJ-bbbbbb' };
    await expect(verifyGithubOidc(mint({}), scope, keys, NOW)).rejects.toThrow(/not registered/i);
  });

  it('refuses a valid token presented against another organization', async () => {
    // The mapping row lives in A, so scoping to B finds nothing. Structural rather than an
    // application check somebody could forget to write.
    const scope = { organization: 'ORG-bbbbbb', project: 'PRJ-aaaaaa', audience: AUDIENCE };
    await expect(verifyGithubOidc(mint({}), scope, keys, NOW)).rejects.toThrow(/not registered/i);
  });

  it('gives the same refusal for unmapped and mismapped, so neither enumerates', async () => {
    // Distinguishing them would tell a caller which repositories an organization owns.
    const unmapped = await verifyGithubOidc(mint({ repository: 'x/y' }), scopeA, keys, NOW).catch(
      (error: Error) => error.message,
    );
    const mismapped = await verifyGithubOidc(
      mint({}),
      { ...scopeA, project: 'PRJ-bbbbbb' },
      keys,
      NOW,
    ).catch((error: Error) => error.message);
    expect(unmapped).toBe(mismapped);
  });
});

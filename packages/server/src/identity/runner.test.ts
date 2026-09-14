import { beforeAll, describe, expect, it } from 'vitest';

import {
  RunnerAuthError,
  hashSecret,
  issueRunnerJwt,
  splitToken,
  verifyRunnerJwt,
} from './runner.ts';
import type { TenantContext } from '../tenancy/db.ts';

/**
 * The half of runner credentials that needs no database.
 *
 * The registration and revocation paths are in `runner.db.test.ts`, because they are about
 * rows and the tenant boundary. What is here is signing, expiry, and the token shape, all of
 * which are decisions this file can be wrong about on its own.
 */

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);

const ctx: TenantContext = {
  organization: 'ORG-aaaaaa',
  principal: { kind: 'runner', id: 'RNR-1', role: 'member' },
};

beforeAll(() => {
  process.env['RUNNER_JWT_SECRET'] = 'local-test-secret';
});

describe('the registration token shape', () => {
  it('splits an organization from a secret', () => {
    const { organization, secret } = splitToken('ORG-aaaaaa.abcdef');
    expect(organization).toBe('ORG-aaaaaa');
    expect(secret).toBe('abcdef');
  });

  it('keeps everything after the first dot, since a secret may contain one', () => {
    // base64url does not produce a dot, but a future encoding might, and splitting on the
    // last separator instead would quietly truncate the secret.
    expect(splitToken('ORG-a.one.two').secret).toBe('one.two');
  });

  it('refuses a token with no organization or no secret', () => {
    for (const bad of ['', '.', 'ORG-a.', '.secret', 'nodot']) {
      expect(() => splitToken(bad)).toThrow(RunnerAuthError);
    }
  });

  it('hashes a secret to something that is not the secret', () => {
    // The runners table holds this and never the plaintext.
    const hash = hashSecret('a-secret');
    expect(hash).not.toContain('a-secret');
    expect(hash).toHaveLength(64);
    expect(hashSecret('a-secret')).toBe(hash);
    expect(hashSecret('a-secrew')).not.toBe(hash);
  });
});

describe('the short lived JWT', () => {
  it('round trips the context it was issued for', () => {
    const token = issueRunnerJwt(ctx, NOW);
    const back = verifyRunnerJwt(token, NOW + 1000);
    expect(back.organization).toBe('ORG-aaaaaa');
    expect(back.principal.id).toBe('RNR-1');
    expect(back.principal.kind).toBe('runner');
  });

  it('refuses one that has expired', () => {
    // The stage exit criterion asks for this by name.
    const token = issueRunnerJwt(ctx, NOW, 600);
    expect(() => verifyRunnerJwt(token, NOW + 601_000)).toThrow(/expired/i);
  });

  it('is still valid one second before it expires', () => {
    const token = issueRunnerJwt(ctx, NOW, 600);
    expect(() => verifyRunnerJwt(token, NOW + 599_000)).not.toThrow();
  });

  it('refuses a tampered payload', () => {
    const token = issueRunnerJwt(ctx, NOW);
    const [head, , signature] = token.split('.') as [string, string, string];
    const forged = Buffer.from(
      JSON.stringify({
        sub: 'RNR-1',
        org: 'ORG-bbbbbb',
        role: 'owner',
        iat: 0,
        exp: 9_999_999_999,
      }),
    ).toString('base64url');
    expect(() => verifyRunnerJwt(`${head}.${forged}.${signature}`, NOW)).toThrow(/signature/i);
  });

  it('refuses an unsigned token claiming alg none', () => {
    // The algorithm is fixed rather than read from the header. A verifier that trusts the
    // token's own `alg` is how "alg: none" became a category of vulnerability.
    const head = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        sub: 'RNR-1',
        org: 'ORG-aaaaaa',
        role: 'owner',
        iat: 0,
        exp: 9_999_999_999,
      }),
    ).toString('base64url');
    expect(() => verifyRunnerJwt(`${head}.${body}.`, NOW)).toThrow(RunnerAuthError);
  });

  it('refuses a token signed with a different secret', () => {
    const token = issueRunnerJwt(ctx, NOW);
    process.env['RUNNER_JWT_SECRET'] = 'a-different-secret';
    try {
      expect(() => verifyRunnerJwt(token, NOW)).toThrow(/signature/i);
    } finally {
      process.env['RUNNER_JWT_SECRET'] = 'local-test-secret';
    }
  });

  it('refuses anything that is not three parts', () => {
    for (const bad of ['', 'one', 'one.two', 'one.two.three.four']) {
      expect(() => verifyRunnerJwt(bad, NOW)).toThrow(RunnerAuthError);
    }
  });
});

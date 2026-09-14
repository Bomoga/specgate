import { describe, expect, it } from 'vitest';

import { CredentialRefError, parseCredentialRef } from './credentials.ts';

/**
 * The reference rules, which need no database.
 *
 * The engine already refuses a literal secret in `specgate.config.yaml` and names the
 * environment variable to use instead. This is that rule widened to a Vault path and a
 * secrets manager ARN, and it has to stay exactly as strict: the control plane storing a
 * credential value would breach I8 for the one kind of data most tempting to excuse.
 */

describe('environment variable references', () => {
  it('accepts the shape the engine already enforces', () => {
    expect(parseCredentialRef('env', 'LEDGER_OWNER_TOKEN').ref).toBe('LEDGER_OWNER_TOKEN');
    expect(parseCredentialRef('env', 'A1_B2').kind).toBe('env');
  });

  it('refuses something that is not a variable name', () => {
    for (const bad of ['lowercase', '1LEADING_DIGIT', 'HAS-DASH', '']) {
      expect(() => parseCredentialRef('env', bad)).toThrow(CredentialRefError);
    }
  });
});

describe('vault and secrets manager references', () => {
  it('accepts a Vault path with and without a field', () => {
    expect(parseCredentialRef('vault', 'secret/data/ledger').kind).toBe('vault');
    expect(parseCredentialRef('vault', 'secret/data/ledger#owner_token').kind).toBe('vault');
  });

  it('refuses a Vault reference with no path separator', () => {
    expect(() => parseCredentialRef('vault', 'secret')).toThrow(/Vault path/i);
  });

  it('accepts a secrets manager ARN', () => {
    const arn = 'arn:aws:secretsmanager:eu-west-2:123456789012:secret:ledger-owner';
    expect(parseCredentialRef('aws-secret', arn).ref).toBe(arn);
  });

  it('refuses an ARN for a different service', () => {
    const arn = 'arn:aws:s3:eu-west-2:123456789012:secret:ledger-owner';
    expect(() => parseCredentialRef('aws-secret', arn)).toThrow(/ARN/i);
  });

  it('refuses an unknown reference kind', () => {
    expect(() => parseCredentialRef('plaintext', 'anything')).toThrow(
      /not a credential reference/i,
    );
  });
});

describe('refusing the credential itself', () => {
  it('catches the common token shapes by prefix', () => {
    // Not exhaustive and not meant to be. The shape rules are the real defence; this exists
    // so the common mistake gets a message naming the fix.
    for (const secret of [
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'xoxb-1234-5678-abcdefghijklmnop',
      'sk-abcdefghijklmnopqrstuvwxyz',
      'AKIAIOSFODNN7EXAMPLE',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def',
    ]) {
      expect(() => parseCredentialRef('env', secret)).toThrow(/value rather than a reference/i);
    }
  });

  it('catches an environment variable name long enough to be a secret', () => {
    expect(() => parseCredentialRef('env', 'A'.repeat(65))).toThrow(
      /value rather than a reference/i,
    );
  });

  it('does not apply the environment limit to paths and ARNs', () => {
    // This is the regression, and the test above caught it. The length rule started as one
    // number for every kind and refused every realistic secrets manager ARN, because the
    // example in the error message is itself sixty five characters. A single limit cannot
    // serve a variable name and an ARN without either letting a secret through or refusing
    // a legitimate reference.
    const arn = 'arn:aws:secretsmanager:eu-west-2:123456789012:secret:ledger-owner';
    expect(arn.length).toBeGreaterThan(64);
    expect(() => parseCredentialRef('aws-secret', arn)).not.toThrow();

    const deepPath = 'secret/data/' + 'team/'.repeat(8) + 'ledger#owner_token';
    expect(deepPath.length).toBeGreaterThan(64);
    expect(() => parseCredentialRef('vault', deepPath)).not.toThrow();
  });

  it('catches anything containing whitespace', () => {
    expect(() => parseCredentialRef('env', 'MY TOKEN')).toThrow(/value rather than a reference/i);
  });

  it('says what to write instead, rather than only refusing', () => {
    // The engine's message names the variable to use. This one names all three shapes,
    // because the platform accepts more than one.
    const message = (() => {
      try {
        parseCredentialRef('env', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789');
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    })();

    expect(message).toMatch(/environment variable name/i);
    expect(message).toMatch(/Vault path/i);
    expect(message).toMatch(/secrets manager ARN/i);
  });
});

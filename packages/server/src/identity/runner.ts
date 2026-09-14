import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Role } from '../tenancy/roles.ts';
import { withTenant, type TenantContext, type Tx } from '../tenancy/db.ts';

/**
 * Runner credentials: a long lived registration token, exchanged for a short lived JWT.
 *
 * **The token carries its organization, and that is a consequence of taking I9 seriously.**
 * Verifying a token means finding which runner it belongs to, which is a lookup across every
 * organization, and row level security exists precisely to make that impossible. The obvious
 * escapes are both bad: a privileged connection that reads the table unscoped is the
 * unscoped accessor this design refuses to have, and a SECURITY DEFINER function is the same
 * hole with a nicer name. So the token is `ORG-xxxxxx.<secret>`: the organization is
 * readable without a lookup, the tenant context is set from it, and the secret is then
 * checked inside that scope. A forged organization prefix buys nothing, because the secret
 * still has to match a row that only exists inside the real organization.
 *
 * **No credential value is stored, ever.** The runners table holds a SHA-256 of the secret.
 * The plaintext is returned once, at registration, and never again.
 */

/** Returned once. The caller shows it to a human and this service forgets it. */
export interface RunnerCredential {
  readonly runnerId: string;
  /** `ORG-xxxxxx.<secret>`. Not recoverable after this. */
  readonly token: string;
}

export interface RunnerRegistration {
  readonly runnerId: string;
  readonly projectId: string;
  readonly name: string;
}

/** Why a token was refused. A caller turns this into a status code, never into prose here. */
export type RunnerRefusal =
  'malformed' | 'unknown' | 'revoked' | 'expired' | 'signature' | 'no-secret';

export class RunnerAuthError extends Error {
  readonly refusal: RunnerRefusal;
  constructor(refusal: RunnerRefusal, message: string) {
    super(message);
    this.name = 'RunnerAuthError';
    this.refusal = refusal;
  }
}

/** A high entropy secret. 32 bytes, so a hash of it needs no salt or stretching. */
function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Compares without leaking where two values first differ. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Splits `ORG-xxxxxx.<secret>` without trusting either half yet. */
export function splitToken(token: string): { organization: string; secret: string } {
  const at = token.indexOf('.');
  if (at <= 0 || at === token.length - 1) {
    throw new RunnerAuthError('malformed', 'a runner token is an organization and a secret');
  }
  return { organization: token.slice(0, at), secret: token.slice(at + 1) };
}

/**
 * Registers a runner and returns its credential once.
 *
 * Runs inside the caller's tenant context, so a registration can only ever create a runner
 * in the organization the caller already holds.
 */
export async function registerRunner(
  request: RunnerRegistration,
  ctx: TenantContext,
): Promise<RunnerCredential> {
  const secret = newSecret();
  await withTenant(ctx, async (tx: Tx) => {
    await tx`
      insert into runners (id, organization_id, project_id, name, token_hash)
      values (${request.runnerId}, ${ctx.organization}, ${request.projectId}, ${request.name}, ${hashSecret(secret)})
    `;
  });
  return { runnerId: request.runnerId, token: `${ctx.organization}.${secret}` };
}

/** Revokes one runner. Individual, per the module: never "revoke everything for a project". */
export async function revokeRunner(runnerId: string, ctx: TenantContext): Promise<boolean> {
  const rows = await withTenant(ctx, async (tx: Tx) => {
    return tx<{ id: string }[]>`
      update runners set revoked_at = now()
      where id = ${runnerId} and revoked_at is null
      returning id
    `;
  });
  return rows.length === 1;
}

/**
 * Verifies a registration token and returns the context it authorizes.
 *
 * The organization comes from the token and is used to scope the lookup. It is not trusted:
 * the secret must still match a row that exists inside that organization, and a row only
 * exists there if this service created it.
 */
export async function verifyRunnerToken(token: string): Promise<TenantContext> {
  const { organization, secret } = splitToken(token);

  // A placeholder principal, only so the lookup has a context to run in. The real principal
  // is built from the row once it is found.
  const probe: TenantContext = {
    organization,
    principal: { kind: 'runner', id: 'pending', role: 'member' },
  };

  const rows = await withTenant(probe, async (tx: Tx) => {
    return tx<{ id: string; token_hash: string; revoked_at: Date | null }[]>`
      select id, token_hash, revoked_at from runners where organization_id = ${organization}
    `;
  });

  const presented = hashSecret(secret);
  const match = rows.find((row) => sameSecret(row.token_hash, presented));
  if (match === undefined) {
    throw new RunnerAuthError('unknown', 'no runner holds that token');
  }
  if (match.revoked_at !== null) {
    throw new RunnerAuthError('revoked', 'that runner credential was revoked');
  }

  return {
    organization,
    principal: { kind: 'runner', id: match.id, role: runnerRole() },
  };
}

/**
 * What a runner may do.
 *
 * A runner submits runs and reads its own project. It is not a person and holds no
 * administrative capability, so it sits at `member` rather than being given a role of its
 * own. A fifth role for one caller would be a policy engine starting.
 */
function runnerRole(): Role {
  return 'member';
}

/* ------------------------------------------------------------------ short lived JWT ---- */

/**
 * HS256, written here rather than pulled in.
 *
 * `04-CONVENTIONS.md` forbids a dependency without approval and the platform's approved list
 * for `server` carries no JWT library. Signing and verifying one is thirty lines of
 * `node:crypto`, and the alternative is an unapproved dependency for an algorithm that is a
 * base64url join and an HMAC.
 */
interface JwtClaims {
  readonly sub: string;
  readonly org: string;
  readonly role: Role;
  readonly exp: number;
  readonly iat: number;
}

function b64(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function secretKey(): Buffer {
  const value = process.env['RUNNER_JWT_SECRET'];
  if (value === undefined || value === '') {
    throw new RunnerAuthError('no-secret', 'RUNNER_JWT_SECRET is not set');
  }
  return Buffer.from(value, 'utf8');
}

function sign(payload: string): string {
  return createHmac('sha256', secretKey()).update(payload).digest('base64url');
}

/** Mints a short lived JWT for a verified runner. Default ten minutes. */
export function issueRunnerJwt(ctx: TenantContext, nowMs: number, ttlSeconds = 600): string {
  const iat = Math.floor(nowMs / 1000);
  const claims: JwtClaims = {
    sub: ctx.principal.id,
    org: ctx.organization,
    role: ctx.principal.role,
    iat,
    exp: iat + ttlSeconds,
  };
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify(claims));
  return `${head}.${body}.${sign(`${head}.${body}`)}`;
}

/**
 * Verifies a runner JWT.
 *
 * The signature is checked before anything in the payload is believed, and the algorithm is
 * fixed rather than read from the header. A verifier that reads `alg` from the token it is
 * verifying is how `alg: none` became a category of vulnerability.
 */
export function verifyRunnerJwt(token: string, nowMs: number): TenantContext {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new RunnerAuthError('malformed', 'a JWT has three parts');
  }
  const [head, body, signature] = parts as [string, string, string];

  const expected = sign(`${head}.${body}`);
  if (!sameSecret(expected, signature)) {
    throw new RunnerAuthError('signature', 'the signature does not match');
  }

  let claims: JwtClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as JwtClaims;
  } catch {
    throw new RunnerAuthError('malformed', 'the payload is not JSON');
  }

  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= nowMs) {
    throw new RunnerAuthError('expired', 'that token has expired');
  }

  return {
    organization: claims.org,
    principal: { kind: 'runner', id: claims.sub, role: claims.role },
  };
}

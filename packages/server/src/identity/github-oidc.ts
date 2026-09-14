import { createPublicKey, createVerify } from 'node:crypto';

import { withTenant, type TenantContext, type Tx } from '../tenancy/db.ts';
import { RunnerAuthError } from './runner.ts';

/**
 * GitHub OIDC, so a runner inside Actions holds no secret at all.
 *
 * **Built now rather than retrofitted.** The module is explicit about why: retrofitting it
 * means every early customer has a long lived token sitting in their repository settings
 * forever, and nobody goes back to remove one that still works.
 *
 * **The scope is passed in, and that deviates from the module's signature.** It sketches
 * `verifyGithubOidc(token, project)`, which implies looking a project up to discover its
 * organization. That is a cross tenant read and row level security exists to forbid it. The
 * runner token solved the same problem by carrying its organization, and that is not
 * available here because GitHub issues this token and decides its claims. So the caller
 * supplies the organization, which a request has: it arrives addressed to one.
 *
 * **The key set is injected.** Verifying really means fetching GitHub's JWKS, and rule R9
 * says a test never touches the network. Passing the keys in means the tests sign with a
 * keypair they generated and the production path fetches and caches, with no branch in this
 * function that only runs in one of the two.
 */

/** GitHub's issuer. Checked exactly; a token from anywhere else is not this. */
export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';

/** One key from a JWKS document, in the shape `crypto.createPublicKey` accepts. */
export interface JsonWebKey {
  readonly kid: string;
  readonly kty: string;
  readonly n: string;
  readonly e: string;
  readonly alg?: string;
}

export interface OidcScope {
  readonly organization: string;
  readonly project: string;
  /** What this control plane expects in `aud`. A token minted for somebody else is refused. */
  readonly audience: string;
}

/** The claims this path cares about. GitHub sends many more and they are ignored. */
interface GithubClaims {
  readonly iss: string;
  readonly aud: string | readonly string[];
  readonly exp: number;
  readonly nbf?: number;
  /** `owner/repo`. */
  readonly repository: string;
  /** `repo:owner/repo:ref:refs/heads/main` and similar. Carried through for the activity log. */
  readonly sub: string;
}

function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new RunnerAuthError('malformed', 'a JWT segment is not JSON');
  }
}

/**
 * Verifies the RS256 signature against the key the token names.
 *
 * The key is chosen by `kid` from the supplied set rather than from anything inside the
 * payload, and the algorithm is fixed at RS256. Reading `alg` from the token being verified
 * is how `alg: none` became a category of vulnerability, and accepting an HMAC algorithm here
 * would let a caller sign with the public key as if it were a shared secret.
 */
function verifySignature(
  token: string,
  keys: readonly JsonWebKey[],
): { head: string; body: string } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new RunnerAuthError('malformed', 'a JWT has three parts');
  const [head, body, signature] = parts as [string, string, string];

  const header = decodeSegment(head) as { alg?: unknown; kid?: unknown };
  if (header.alg !== 'RS256') {
    throw new RunnerAuthError('signature', 'only RS256 is accepted from the identity provider');
  }
  if (typeof header.kid !== 'string') {
    throw new RunnerAuthError('malformed', 'the token names no key');
  }

  const jwk = keys.find((key) => key.kid === header.kid);
  if (jwk === undefined) {
    throw new RunnerAuthError('signature', 'no published key matches the one the token names');
  }

  const key = createPublicKey({ key: jwk as unknown as Record<string, unknown>, format: 'jwk' });
  const ok = createVerify('RSA-SHA256')
    .update(`${head}.${body}`)
    .verify(key, Buffer.from(signature, 'base64url'));

  if (!ok) throw new RunnerAuthError('signature', 'the signature does not match');
  return { head, body };
}

/**
 * Verifies a GitHub OIDC token and returns the context it authorizes.
 *
 * Order matters: the signature is checked before any claim is believed, then issuer and
 * audience, then expiry, and only then is the repository looked up. A lookup driven by an
 * unverified claim would be a lookup an attacker chooses.
 */
export async function verifyGithubOidc(
  token: string,
  scope: OidcScope,
  keys: readonly JsonWebKey[],
  nowMs: number,
): Promise<TenantContext> {
  const { body } = verifySignature(token, keys);
  const claims = decodeSegment(body) as GithubClaims;

  if (claims.iss !== GITHUB_ISSUER) {
    throw new RunnerAuthError('signature', 'that token was not issued by GitHub Actions');
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(scope.audience)) {
    // A token minted for a different audience is a valid token somebody else was given.
    throw new RunnerAuthError('signature', 'that token was minted for a different audience');
  }

  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= nowMs) {
    throw new RunnerAuthError('expired', 'that token has expired');
  }
  if (typeof claims.nbf === 'number' && claims.nbf * 1000 > nowMs) {
    throw new RunnerAuthError('expired', 'that token is not valid yet');
  }
  if (typeof claims.repository !== 'string' || claims.repository === '') {
    throw new RunnerAuthError('malformed', 'the token names no repository');
  }

  // Scoped to the organization the request addressed, so this is not a cross tenant read.
  const probe: TenantContext = {
    organization: scope.organization,
    principal: { kind: 'runner', id: 'pending', role: 'member' },
  };

  const rows = await withTenant(probe, async (tx: Tx) => {
    return tx<{ id: string; project_id: string }[]>`
      select id, project_id from github_repositories
      where repository = ${claims.repository} and project_id = ${scope.project}
    `;
  });

  const mapping = rows[0];
  if (mapping === undefined) {
    // Deliberately the same refusal whether the repository is unmapped or mapped to a
    // different project. Distinguishing them would tell a caller which repositories this
    // organization owns.
    throw new RunnerAuthError('unknown', 'that repository is not registered for this project');
  }

  return {
    organization: scope.organization,
    principal: { kind: 'runner', id: `github:${claims.repository}`, role: 'member' },
  };
}

/** Registers a repository against a project, inside the caller's own organization. */
export async function mapRepository(
  input: { id: string; projectId: string; repository: string; installationId?: string },
  ctx: TenantContext,
): Promise<void> {
  await withTenant(ctx, async (tx: Tx) => {
    await tx`
      insert into github_repositories (id, organization_id, project_id, repository, installation_id)
      values (${input.id}, ${ctx.organization}, ${input.projectId}, ${input.repository}, ${input.installationId ?? null})
    `;
  });
}

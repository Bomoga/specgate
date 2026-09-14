import { withTenant, type TenantContext, type Tx } from '../tenancy/db.ts';

/**
 * Where an actor's credential lives, never what it is.
 *
 * **"Actor" is the engine's meaning here and the only one**: a configured identity used to
 * interact with a target. A person who logs in to the control plane is a principal. The
 * vocabulary table keeps these apart and so does this file.
 *
 * **This generalizes a rule the engine already enforces.** `target/config.ts` constrains
 * `tokenEnv` and `valueEnv` to look like environment variable names, and rejects a literal
 * secret at load with a message naming the variable to use instead, because a secret in a
 * file that lives in a repository is the failure this tool was built to notice in other
 * people's software. The platform widens the shape to a Vault path or a secrets manager ARN
 * and keeps the prohibition exactly as strict.
 */

export type CredentialRef =
  | { readonly kind: 'env'; readonly ref: string }
  | { readonly kind: 'vault'; readonly ref: string }
  | { readonly kind: 'aws-secret'; readonly ref: string };

export const REF_KINDS = ['env', 'vault', 'aws-secret'] as const;

export class CredentialRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialRefError';
  }
}

/** The engine's rule, unchanged: `LEDGER_OWNER_TOKEN`, not a value. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
/** `secret/data/team/app#field`, the shape a Vault KV v2 path takes. */
const VAULT_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+(?:#[A-Za-z0-9_.-]+)?$/;
/** `arn:aws:secretsmanager:<region>:<account>:secret:<name>`. */
const AWS_SECRET_ARN =
  /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/;

/**
 * How long a reference of each kind can plausibly be.
 *
 * **Per kind, because a single limit is wrong for at least one of them.** This started as a
 * blanket sixty characters and rejected every realistic secrets manager ARN: the example in
 * the message below is sixty five. An environment variable name really is short, and a Vault
 * path or an ARN really is not, so one number cannot serve all three without either letting a
 * secret through or refusing a legitimate reference.
 */
const MAX_LENGTH: Readonly<Record<CredentialRef['kind'], number>> = {
  env: 64,
  vault: 512,
  'aws-secret': 512,
};

/**
 * Things that are probably the secret itself rather than a name for it.
 *
 * Deliberately a heuristic and deliberately loud. It cannot catch every literal, and the
 * shape rules above are the real defence; this exists so that the common mistake gets a
 * message naming the fix rather than a regex failure a reader has to decode.
 */
function looksLikeAValue(candidate: string, kind: CredentialRef['kind']): boolean {
  return (
    candidate.length > MAX_LENGTH[kind] ||
    /^(gh[pousr]_|xox[baprs]-|sk-|AKIA|eyJ)/.test(candidate) ||
    /\s/.test(candidate)
  );
}

/** Validates a reference, or explains what to write instead. */
export function parseCredentialRef(kind: string, ref: string): CredentialRef {
  if (!(REF_KINDS as readonly string[]).includes(kind)) {
    throw new CredentialRefError(
      `"${kind}" is not a credential reference kind. Use one of ${REF_KINDS.join(', ')}.`,
    );
  }

  if (looksLikeAValue(ref, kind as CredentialRef['kind'])) {
    throw new CredentialRefError(
      'that looks like a credential value rather than a reference to one. The control plane stores where a credential lives and never the credential, so a runner can resolve it inside your own boundary. Use an environment variable name, a Vault path, or a secrets manager ARN.',
    );
  }

  const shapes = {
    env: [ENV_NAME, 'an environment variable name, for example LEDGER_OWNER_TOKEN'],
    vault: [VAULT_PATH, 'a Vault path, for example secret/data/ledger#owner_token'],
    'aws-secret': [
      AWS_SECRET_ARN,
      'a secrets manager ARN, for example arn:aws:secretsmanager:eu-west-2:123456789012:secret:ledger-owner',
    ],
  } as const;

  const [pattern, example] = shapes[kind as CredentialRef['kind']];
  if (!pattern.test(ref)) {
    throw new CredentialRefError(`a "${kind}" reference must be ${example}.`);
  }

  return { kind: kind as CredentialRef['kind'], ref };
}

export interface ActorRecord {
  readonly id: string;
  readonly environmentId: string;
  readonly actorId: string;
  readonly credential: CredentialRef;
}

/** Records where an actor's credential lives. Refuses to record the credential. */
export async function putActor(record: ActorRecord, ctx: TenantContext): Promise<void> {
  const credential = parseCredentialRef(record.credential.kind, record.credential.ref);
  await withTenant(ctx, async (tx: Tx) => {
    await tx`
      insert into environment_actors (id, organization_id, environment_id, actor_id, ref_kind, ref)
      values (${record.id}, ${ctx.organization}, ${record.environmentId}, ${record.actorId}, ${credential.kind}, ${credential.ref})
      on conflict (organization_id, environment_id, actor_id)
      do update set ref_kind = excluded.ref_kind, ref = excluded.ref
    `;
  });
}

/**
 * What a run reported about resolving an actor.
 *
 * Recorded rather than inferred. The control plane cannot resolve these itself by
 * construction, so the only honest source is the runner saying what it managed.
 */
export async function recordResolution(
  input: { environmentId: string; actorId: string; resolved: boolean; failure?: string },
  at: Date,
  ctx: TenantContext,
): Promise<void> {
  await withTenant(ctx, async (tx: Tx) => {
    await tx`
      update environment_actors
      set last_resolved_at = ${input.resolved ? at : null},
          last_failure = ${input.resolved ? null : (input.failure ?? 'the runner could not resolve this credential')}
      where environment_id = ${input.environmentId} and actor_id = ${input.actorId}
    `;
  });
}

export interface ActorHealth {
  readonly actorId: string;
  readonly environmentId: string;
  readonly kind: string;
  readonly ref: string;
  readonly failure: string | null;
  readonly neverResolved: boolean;
}

/**
 * Actors that cannot be resolved, as a project health signal.
 *
 * **Why this is surfaced at all.** `credentials.ts` in the engine drops an actor it cannot
 * resolve, and the only place that shows is the capability report, which a reader has to be
 * looking at. Access checking compares one identity against another, so losing an actor
 * silently reduces a run to one that establishes almost nothing while still exiting zero.
 * That is precisely the failure the whole product exists to prevent, and it is worse when
 * the tool does it to itself.
 */
export async function unresolvedActors(
  environmentId: string,
  ctx: TenantContext,
): Promise<readonly ActorHealth[]> {
  const rows = await withTenant(ctx, async (tx: Tx) => {
    return tx<
      {
        actor_id: string;
        environment_id: string;
        ref_kind: string;
        ref: string;
        last_failure: string | null;
        last_resolved_at: Date | null;
      }[]
    >`
      select actor_id, environment_id, ref_kind, ref, last_failure, last_resolved_at
      from environment_actors
      where environment_id = ${environmentId}
        and (last_resolved_at is null or last_failure is not null)
      order by actor_id
    `;
  });

  return rows.map((row) => ({
    actorId: row.actor_id,
    environmentId: row.environment_id,
    kind: row.ref_kind,
    ref: row.ref,
    failure: row.last_failure,
    neverResolved: row.last_resolved_at === null,
  }));
}

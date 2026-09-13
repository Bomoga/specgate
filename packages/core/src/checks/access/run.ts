import type { Reporter } from '../../report/reporter.ts';
import type { ActorSession } from '../../target/session.ts';
import { fail, inconclusive, pass } from '../result.ts';
import type { CheckResult } from '../types.ts';
import { selectCandidate, type CandidateRecord } from './evaluate.ts';
import {
  allowFailureDetail,
  denyFailureDetail,
  destructiveFailureDetail,
  listFailureDetail,
  passDetail,
  severityForAccessFailure,
} from './findings.ts';
import { assessDenyListOutcome } from './list.ts';
import { resolvePath, type AccessCheckPlan } from './plan.ts';
import { assessAllowOutcome, assessDenyOutcome } from './verdict.ts';

/**
 * Executing an access check.
 *
 * The order is fixed by rule R7: resolve a target record, issue the request, capture
 * evidence, then decide. The session captures evidence on every request including one
 * that never connected, so a verdict here always has an evidence id to point at.
 *
 * Nothing in this file consults a model, and the verdict comes entirely from the
 * assessment tables in `verdict.ts`.
 */

export interface AccessRunContext {
  readonly sessions: ReadonlyMap<string, ActorSession>;
  /**
   * Where progress goes. Absent discards it, so no code path has to test whether it was
   * given one. Threading it here is what lets a run stream progress to something that is
   * not a terminal, which is why a port declared for tidiness turns out to be load bearing.
   */
  readonly reporter?: Reporter;

  /**
   * Who persisted state is read as, when a destructive check has to confirm what it did.
   *
   * It cannot be the acting actor: a deny check acts as the identity the rule says must
   * be refused, so reading the record as that actor would report a scoping rule as a
   * state fact. Named by `TargetConfig.stateActor`, the same field M5.11 reads for the
   * same reason. Absent means a destructive check keeps the verdict the response alone
   * supports.
   */
  readonly stateActorId?: string;
  /**
   * Absent means mutating checks are not permitted. Supplied by the caller from the
   * M2 disposability gate rather than recomputed here, so there is one interlock
   * rather than two implementations of one.
   */
  readonly mutation?: MutationPermission;
}

export interface MutationPermission {
  readonly allowed: boolean;
  /** Why not, written for someone who has to change something. Present when refused. */
  readonly refusal?: string;
  /** Restores the target between mutating checks. Absent means no reset is possible. */
  reset?: () => Promise<void>;
}

/** Actions that act on one record and therefore need one identified first. */
const INSTANCE_ACTIONS = new Set(['read', 'update', 'delete']);

function candidatesOf(plan: AccessCheckPlan): CandidateRecord[] {
  return plan.candidates.map((instance) => ({
    id: instance.id,
    attributes: instance.attributes,
  }));
}

/**
 * One reading of the record under test, as the configured state actor.
 *
 * Only for a delete, and only when there is a state actor and a read route. Everything
 * else returns undefined and the check keeps the verdict the response alone supports,
 * which is the conservative answer rather than a guess dressed as one.
 */
async function readRecord(
  plan: AccessCheckPlan,
  context: AccessRunContext,
  instanceId: string | undefined,
): Promise<{ present: boolean; evidenceId: string } | undefined> {
  if (plan.action !== 'delete') return undefined;
  if (plan.confirmReadTemplate === undefined || instanceId === undefined) return undefined;

  const stateActorId = context.stateActorId;
  if (stateActorId === undefined) return undefined;

  const reader = context.sessions.get(stateActorId);
  if (reader === undefined) return undefined;

  const { outcome, evidenceId } = await reader.request({
    method: 'GET',
    path: resolvePath(plan.confirmReadTemplate, instanceId),
  });

  if (outcome.kind !== 'response') return undefined;

  // Present means the reader could see the record. A refusal is not absence: the state
  // actor being unable to read it says something about that actor, not about the record,
  // so only a 2xx counts as present and only a 404 counts as gone.
  const status = outcome.response.status;
  if (status >= 200 && status < 300) return { present: true, evidenceId };
  if (status === 404) return { present: false, evidenceId };

  return undefined;
}

/**
 * A deny rule tried against every instance it denies, rather than against one.
 *
 * The corpus found the reason twice: an application enforced the rule on the instance the
 * tool picked and leaked a different one, so the access family reported a pass and a
 * behavioral criterion caught the defect instead. Enforcing on one record and not another
 * is the shape of a scoping bug and is invisible to a check that stops at the first
 * refusal.
 *
 * The first failure ends the sweep. The finding is already made, and continuing would
 * issue requests that cannot change the verdict. A pass requires every instance to have
 * been refused and says how many that was, so a reader can see the scope of the claim.
 *
 * **Mutating rules are not swept.** A delete tried against four records destroys four
 * records, and the reset in `runAccessChecks` runs between checks rather than inside one.
 * One instance, as before.
 */
export async function runAccessCheck(
  plan: AccessCheckPlan,
  context: AccessRunContext,
): Promise<CheckResult> {
  const session = context.sessions.get(plan.actorId);

  if (
    session === undefined ||
    plan.rule.effect !== 'deny' ||
    plan.mutates ||
    !INSTANCE_ACTIONS.has(plan.action)
  ) {
    return attemptAccessCheck(plan, context);
  }

  const selection = selectCandidate(
    candidatesOf(plan),
    plan.condition,
    plan.resource,
    session.attributes,
  );

  const instances = selection.all ?? [];
  if (instances.length < 2) return attemptAccessCheck(plan, context);

  const attempts: CheckResult[] = [];

  for (const instance of instances) {
    const result = await attemptAccessCheck(plan, context, instance.id);
    attempts.push(result);
    if (result.verdict === 'fail') return result;
  }

  const undecided = attempts.find((result) => result.verdict === 'inconclusive');
  if (undecided !== undefined) return undecided;

  const last = attempts[attempts.length - 1] as CheckResult;
  return {
    ...last,
    detail:
      `${last.detail ?? ''} Every one of the ${instances.length} configured ${plan.resource} instance(s) the rule denies was refused.`.trim(),
    evidence: attempts.flatMap((result) => result.evidence),
  };
}

async function attemptAccessCheck(
  plan: AccessCheckPlan,
  context: AccessRunContext,
  forcedInstanceId?: string,
): Promise<CheckResult> {
  /**
   * Invariant I7, checked before anything is sent. A mutating check against a target
   * nobody declared disposable does not run, and reports why rather than passing
   * quietly. There is no flag that reaches past this.
   */
  if (plan.mutates && context.mutation?.allowed !== true) {
    return inconclusive({
      identity: plan.identity,
      title: `Mutating check on ${plan.resource} was not attempted`,
      detail:
        context.mutation?.refusal ??
        'The target is not declared disposable with a reset command, so no check that writes to it was run.',
    });
  }

  const session = context.sessions.get(plan.actorId);

  if (session === undefined) {
    return inconclusive({
      identity: plan.identity,
      title: `Actor ${plan.actorId} was not available`,
      detail: `The rule acts as "${plan.actorId}" and no session resolved for it, so the action was never attempted.`,
    });
  }

  let path = plan.pathTemplate;
  let selectedId: string | undefined;

  if (INSTANCE_ACTIONS.has(plan.action)) {
    const selection = selectCandidate(
      candidatesOf(plan),
      plan.condition,
      plan.resource,
      session.attributes,
    );

    if (selection.matched === undefined) {
      /**
       * No suitable record means the check proves nothing, whatever the target
       * answers. Requesting an id that was never seeded would produce a 404 that
       * looks exactly like correct enforcement.
       */
      const because =
        selection.reason === 'no-candidates'
          ? `no instances of ${plan.resource} are configured`
          : selection.reason === 'none-matched'
            ? `no configured ${plan.resource} satisfies the rule condition`
            : `ownership of the configured ${plan.resource} instances could not be established from the rule condition`;

      return inconclusive({
        identity: plan.identity,
        title: `No suitable ${plan.resource} to act on`,
        detail: `The check was not attempted because ${because}. Testing access control against a record that does not exist proves nothing.`,
      });
    }

    selectedId = forcedInstanceId ?? selection.matched.id;
    path = resolvePath(plan.pathTemplate, selectedId);
  }

  // Read before acting, and the ordering is load bearing rather than incidental: a
  // record can only be shown to have been destroyed by having been there first.
  const before = await readRecord(plan, context, selectedId);

  const { outcome, evidenceId } = await session.request({ method: plan.method, path });
  const evidence = [evidenceId, ...(before === undefined ? [] : [before.evidenceId])];
  const request = `${plan.method} ${path}`;
  const where = `${request} as actor ${plan.actorId}`;
  const locationRef = plan.locationRef === undefined ? {} : { locationRef: plan.locationRef };

  if (plan.action === 'list' && plan.rule.effect === 'deny') {
    const assessment = assessDenyListOutcome({
      outcome,
      condition: plan.condition,
      entity: plan.resource,
      actorAttributes: session.attributes,
    });

    if (assessment.verdict === 'fail') {
      return fail(
        {
          identity: plan.identity,
          title: `${plan.resource} list returned rows belonging to another owner`,
          ...listFailureDetail({
            plan,
            request,
            evidenceId,
            ...(assessment.status === undefined ? {} : { status: assessment.status }),
            foreignRowIds: assessment.foreignRowIds,
            totalRows: assessment.totalRows,
          }),
          evidence,
          ...locationRef,
        },
        severityForAccessFailure(plan),
      );
    }

    if (assessment.verdict === 'pass') {
      const note =
        assessment.reason === 'refused'
          ? ''
          : `with ${assessment.totalRows} row(s), none of which the rule denies`;

      return pass({
        identity: plan.identity,
        title: `${plan.resource} list is scoped to actor ${plan.actorId}`,
        detail: passDetail({
          plan,
          request,
          evidenceId,
          ...(assessment.status === undefined ? {} : { status: assessment.status }),
          note,
        }).trim(),
        evidence,
        ...locationRef,
      });
    }

    return inconclusive({
      identity: plan.identity,
      title: `Scoping of the ${plan.resource} list could not be established`,
      detail: describeListInconclusive(where, assessment.reason, assessment.status),
      evidence,
    });
  }

  if (plan.rule.effect === 'deny') {
    const assessment = assessDenyOutcome(outcome, plan.resourceFields);

    if (assessment.verdict === 'fail') {
      return fail(
        {
          identity: plan.identity,
          title: `${plan.resource} readable by actor ${plan.actorId}, which the spec denies`,
          ...denyFailureDetail({
            plan,
            request,
            evidenceId,
            ...(assessment.status === undefined ? {} : { status: assessment.status }),
            observedFields: assessment.observedFields,
          }),
          evidence,
          ...locationRef,
        },
        severityForAccessFailure(plan),
      );
    }

    if (assessment.verdict === 'pass') {
      return pass({
        identity: plan.identity,
        title: `${plan.resource} refused to actor ${plan.actorId}`,
        detail: passDetail({
          plan,
          request,
          evidenceId,
          ...(assessment.status === undefined ? {} : { status: assessment.status }),
          note: `with no ${plan.resource} fields in the body`,
        }),
        evidence,
        ...locationRef,
      });
    }

    /**
     * A destructive request the response cannot settle, settled by the record.
     *
     * Decided by the human on 2026-08-22. A 2xx carrying no resource fields is
     * undecidable from the response alone, which is right for a read and cost a finding
     * on a delete three times across the corpus: the record was destroyed and the tool
     * reported that it could not tell. Present before and gone after is not a guess, it
     * is the strongest evidence this check can hold.
     */
    if (before?.present === true) {
      const after = await readRecord(plan, context, selectedId);

      if (after !== undefined) {
        evidence.push(after.evidenceId);

        if (!after.present) {
          return fail(
            {
              identity: plan.identity,
              title: `${plan.resource} deleted by actor ${plan.actorId}, which the spec denies`,
              ...destructiveFailureDetail({
                plan,
                request,
                evidenceId,
                ...(assessment.status === undefined ? {} : { status: assessment.status }),
                instanceId: selectedId ?? plan.resource,
              }),
              evidence,
              ...locationRef,
            },
            severityForAccessFailure(plan),
          );
        }

        return pass({
          identity: plan.identity,
          title: `${plan.resource} survived a delete by actor ${plan.actorId}`,
          detail: passDetail({
            plan,
            request,
            evidenceId,
            ...(assessment.status === undefined ? {} : { status: assessment.status }),
            note: `and ${plan.resource} ${selectedId ?? ''} is still readable afterwards`.trim(),
          }),
          evidence,
          ...locationRef,
        });
      }
    }

    return inconclusive({
      identity: plan.identity,
      title: `Access to ${plan.resource} by actor ${plan.actorId} could not be established`,
      detail: describeInconclusive(where, assessment.reason, assessment.status),
      evidence,
      ...locationRef,
    });
  }

  const assessment = assessAllowOutcome(outcome, plan.resourceFields);

  if (assessment.verdict === 'pass') {
    return pass({
      identity: plan.identity,
      title: `${plan.resource} reachable by actor ${plan.actorId}, as the spec allows`,
      detail: passDetail({
        plan,
        request,
        evidenceId,
        ...(assessment.status === undefined ? {} : { status: assessment.status }),
        note: '',
      }).trim(),
      evidence,
      ...locationRef,
    });
  }

  if (assessment.verdict === 'fail') {
    return fail(
      {
        identity: plan.identity,
        title: `${plan.resource} refused to actor ${plan.actorId}, which the spec allows`,
        ...allowFailureDetail({
          plan,
          request,
          evidenceId,
          ...(assessment.status === undefined ? {} : { status: assessment.status }),
        }),
        evidence,
        ...locationRef,
      },
      severityForAccessFailure(plan),
    );
  }

  return inconclusive({
    identity: plan.identity,
    title: `Access to ${plan.resource} by actor ${plan.actorId} could not be established`,
    detail: describeInconclusive(where, assessment.reason, assessment.status),
    evidence,
    ...locationRef,
  });
}

/**
 * Runs a batch. Non-mutating checks first, then mutating ones one at a time with a
 * reset between them.
 *
 * The ordering is not a convenience. A mutating check changes what every check after
 * it observes, so running one in the middle of a batch would make the results that
 * follow describe a target that no longer matches the one being reported on. Serial
 * execution with a reset between is what keeps each mutating check answerable on its
 * own, and a reset that fails stops the remaining mutating checks rather than letting
 * them run against a target in an unknown state.
 */
export async function runAccessChecks(
  plans: readonly AccessCheckPlan[],
  context: AccessRunContext,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const plan of plans.filter((candidate) => !candidate.mutates)) {
    results.push(await runAccessCheck(plan, context));
  }

  const mutating = plans.filter((candidate) => candidate.mutates);
  let resetFailed: string | undefined;

  for (const [index, plan] of mutating.entries()) {
    if (resetFailed !== undefined) {
      results.push(
        inconclusive({
          identity: plan.identity,
          title: `Mutating check on ${plan.resource} was not attempted`,
          detail: `An earlier reset did not complete, so the target state is unknown and no further mutating check was run: ${resetFailed}`,
        }),
      );
      continue;
    }

    results.push(await runAccessCheck(plan, context));

    const isLast = index === mutating.length - 1;
    const reset = context.mutation?.reset;
    if (isLast || reset === undefined) continue;

    try {
      await reset();
    } catch (cause) {
      resetFailed = cause instanceof Error ? cause.message : 'the reset command failed';
      context.reporter?.warn(
        `The reset between mutating access checks did not complete, so the remaining mutating checks are not run: ${resetFailed}`,
      );
    }
  }

  return results;
}

/** Q5: an empty list and an unreadable one are different facts and read differently. */
function describeListInconclusive(where: string, reason: string, status?: number): string {
  switch (reason) {
    case 'transport-error':
      return `${where} did not complete, so nothing was established about it`;
    case 'server-error':
      return `${where} returned ${status}, which says nothing about how the list is scoped`;
    case 'no-rows-returned':
      return `${where} returned ${status} with no rows. An empty list may mean the endpoint scopes correctly or that there was nothing to return, and those are not distinguishable from here`;
    case 'no-rows-recognized':
      return `${where} returned ${status} in a shape this check could not read as a list of records`;
    case 'ownership-undecidable':
      return `${where} returned ${status}, but ownership of the returned rows could not be established from the rule condition`;
    default:
      return `${where} returned ${status}, which the verdict table does not cover`;
  }
}

/** States the observation, never the label. See the output style in the style guide. */
function describeInconclusive(where: string, reason: string, status?: number): string {
  switch (reason) {
    case 'transport-error':
      return `${where} did not complete, so nothing was established about it`;
    case 'server-error':
      return `${where} returned ${status}, which says nothing about whether access is enforced`;
    case 'empty-or-unrelated-body':
      return `${where} returned ${status} with no recognizable fields, which may be a refusal or a response in a shape this check does not recognize`;
    default:
      return `${where} returned ${status}, which the verdict table does not cover`;
  }
}

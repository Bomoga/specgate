import type { Reporter } from '../../report/reporter.ts';
import type { CriterionMode } from '../../contracts/index.ts';
import type { PageCaptureOptions } from './browser.ts';
import type { Judge } from './judge.ts';
import type { ActorSession } from '../../target/session.ts';
import type { RequestSpec } from '../../target/request.ts';
import type { CheckPlan } from '../types.ts';
import type { Assertion } from './assertions.ts';

/**
 * A behavioral check resolved to a concrete request, before execution.
 *
 * The request is carried rather than derived. An acceptance criterion states `when` in
 * prose, and there is no vocabulary for turning that into a method and a path the way
 * an access rule's actor, action, and resource fields do. Whoever builds the plan
 * decides what to issue; this module runs what it is handed and asserts on the answer.
 * The gap is recorded in the module's Open questions.
 */
/**
 * Where to look to count an entity's records after the action has been taken.
 *
 * Resolved at planning time rather than in the runner, so route resolution stays in one
 * place and the runner needs to know nothing about configuration.
 */
export interface StateRead {
  readonly entity: string;
  readonly path: string;
}

/**
 * Where to read one record, so it can be compared before and after the action.
 *
 * Resolved at planning time for the same reason `StateRead` is: route resolution lives in
 * one place, and the runner is handed a path rather than the rules for building one.
 */
export interface RecordRead {
  readonly entity: string;
  readonly instanceId: string;
  readonly path: string;
}

/**
 * A second request whose status an assertion compares against.
 *
 * Resolved at planning time like the reads above. Never mutating, which the assertion
 * parser refuses rather than the runner guarding: an assertion that changes the target
 * would break invariant I7 from inside a verdict.
 */
export interface ReferenceRequest {
  /** The authored phrase, which ties this back to the assertion that asked for it. */
  readonly phrase: string;
  readonly actorId: string;
  readonly request: RequestSpec;
}

export interface BehavioralPlan extends CheckPlan {
  readonly requirementId: string;
  readonly criterionId: string;
  readonly actorId: string;
  readonly request: RequestSpec;
  readonly assertions: readonly Assertion[];
  readonly mode: CriterionMode;
  /** The criterion's clauses, as authored. `then` is the finding text; a fuzzy check
   * shows all three to the model so it judges the criterion rather than a fragment. */
  readonly given: string;
  readonly when: string;
  readonly then: string;
  /** A file reference when a probe supplied one, so a finding cites source. */
  readonly locationRef?: string;
  /** One per entity a `record count of` assertion names, where a route was found. */
  readonly stateReads?: readonly StateRead[];
  /** One per record an `is unchanged` assertion names, where a route and instance resolved. */
  readonly recordReads?: readonly RecordRead[];
  /** One per `status matches` assertion whose reference resolved to a route. */
  readonly referenceRequests?: readonly ReferenceRequest[];
  /**
   * The endpoints an `every endpoint` assertion ranges over, taken from the Observation
   * at planning time. Absent means there was no Observation or nothing readable in it,
   * and the runner reports the assertion unevaluable rather than quantifying over nothing.
   */
  readonly endpointSweep?: readonly RequestSpec[];
}

/**
 * What a behavioral runner needs. Deliberately the sessions and the interlock, not the
 * whole `TargetContext`: a check reaches the target through an actor session and has no
 * business touching credentials or the evidence writer directly.
 */
/** What a fuzzy check needs to open a page. Absent means fuzzy criteria cannot run. */
export interface FuzzyBrowserContext {
  readonly baseUrl: string;
  /** How an actor's credential reaches the page. `ActorSession` never exposes one. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Opt in, since an image cannot be redacted the way a JSON body can. */
  readonly screenshotPath?: string;
  /** Injected for tests, so nothing launches a real browser under vitest. */
  readonly launcher?: PageCaptureOptions['launcher'];
}

export interface BehavioralContext {
  readonly sessions: ReadonlyMap<string, ActorSession>;
  /**
   * Where progress goes. Absent discards it, so no code path has to test whether it was
   * given one. Threading it here is what lets a run stream progress to something that is
   * not a terminal, which is why a port declared for tidiness turns out to be load bearing.
   */
  readonly reporter?: Reporter;

  /** Absent means fuzzy criteria report unverified rather than failing the run. */
  readonly browser?: FuzzyBrowserContext;
  /**
   * Who answers a fuzzy criterion. Absent is the ordinary case, since no model client is
   * approved as a dependency yet, and it degrades exactly as an absent browser does: the
   * criterion is unverified for a capability reason rather than assumed either way.
   * `runFuzzyCheck` still takes a judge as an argument, per the module's Public API; this
   * is how the batch runner finds one.
   */
  readonly judge?: Judge;
  /**
   * The actor persisted state is read as, after the action under test. The module calls
   * it the configured owner actor: counting records needs an identity allowed to see
   * them, and using the acting actor would make a scoping bug look like a state bug.
   * Absent means record counts stay unevaluable rather than being guessed at.
   */
  readonly stateActorId?: string;
  /**
   * Mutation permission, decided by the M2 disposability gate and passed in. Absent
   * means refused, so the safe answer is the default rather than something a caller has
   * to remember to ask for.
   */
  readonly mutation?: { readonly allowed: boolean; readonly reason?: string };
}

/** Behavioral findings are medium by default: a broken feature, not an exposure. */
export const BEHAVIORAL_SEVERITY = 'medium' as const;

/**
 * Requirement tags that make a failing criterion `high`. Q8, decided 2026-08-22.
 *
 * Behavioral findings were `medium` from the constant above while the default failure
 * threshold is `high`, so a criterion that caught a real data leak reported it correctly
 * and the run exited 0. Four corpus applications did exactly that: each piece was
 * defensible and the combination told CI an application was fine while the report on
 * screen said anyone could read anyone's private messages.
 *
 * Severity now comes from what the requirement says it is about. The alternative was
 * lowering the default threshold to `medium`, which makes every weak criterion break a
 * build and invites users to raise it back, gaining nothing; invariant I2 is about
 * exactly that. The tag vocabulary already exists in every spec written for this project,
 * and a spec author is better placed than a constant to say whether a requirement is
 * about exposure.
 *
 * Matched case insensitively, because a spec is hand written. An untagged requirement, or
 * one tagged for something else, keeps `medium`: a spec that says nothing about what a
 * requirement is about gets the conservative answer rather than the loud one.
 */
export const HIGH_SEVERITY_TAGS: readonly string[] = ['access-control', 'data-exposure'];

export function behavioralSeverityFor(tags: readonly string[]): 'high' | 'medium' {
  const lowered = tags.map((tag) => tag.toLowerCase());
  return HIGH_SEVERITY_TAGS.some((tag) => lowered.includes(tag)) ? 'high' : BEHAVIORAL_SEVERITY;
}

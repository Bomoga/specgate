import type { UnverifiedReason } from '../../contracts/index.ts';
import { createCheckRegistry } from '../registry.ts';
import { inconclusive } from '../result.ts';
import type { CheckIdentity, CheckResult } from '../types.ts';
import { resolveBrowserCapability, type BrowserCapability } from './browser.ts';
import { runDeterministicCheck } from './deterministic.ts';
import { runFuzzyCheck } from './fuzzy.ts';
import type { BehavioralContext, BehavioralPlan } from './types.ts';

/**
 * Running a batch of behavioral checks, and degrading when the browser is not there.
 *
 * The module is plain about the requirement: with Playwright absent, every fuzzy
 * criterion is unverified with reason `capability-unavailable` and a line telling the
 * user how to enable it, and nothing about that produces an error or a non-zero exit.
 * Three things make that true here.
 *
 * **The capability is decided once, before any check runs.** A run with twelve fuzzy
 * criteria attempts the optional import once, and a missing browser is a fact about the
 * run rather than something each check rediscovers and phrases differently.
 *
 * **A criterion that could not be assessed is `inconclusive`, never `fail`.** The
 * contract says an inconclusive check never by itself produces exit code 1, so the exit
 * code is unaffected by construction rather than by a caller remembering to filter.
 *
 * **The reason travels beside the results, not inside them.** `CheckResult` has no field
 * for an unverified reason and adding one would be a contract change. The closed set in
 * the contract is per requirement, so this returns the reasons it actually knows and
 * whoever assembles the RunResult rolls them up, the same widening `planBehavioralChecks`
 * made with `unplannable`.
 *
 * `capability-unavailable` and `model-inconclusive` are deliberately not merged. Nothing
 * looked at the page is a different fact from a model looked and was unsure, and the
 * first is fixable by installing a dependency while the second is not.
 */

export interface UnverifiedCheck {
  readonly requirementId: string;
  readonly criterionId: string;
  readonly reason: UnverifiedReason;
  readonly detail: string;
}

export interface BehavioralRunResult {
  readonly results: readonly CheckResult[];
  /**
   * Only what this runner establishes on its own: fuzzy criteria that could not be
   * assessed. A deterministic check that came back inconclusive has its reason in its
   * own detail, and guessing which member of the closed set it belongs to would be this
   * module inventing a classification it does not have the facts for.
   */
  readonly unverified: readonly UnverifiedCheck[];
}

const NO_JUDGE =
  'no judge is configured, so the page was not assessed. Configure a model backed judge to enable fuzzy criteria.';

function identityFor(plan: BehavioralPlan): CheckIdentity {
  return {
    type: 'behavioral',
    requirementId: plan.requirementId,
    ruleId: plan.criterionId,
    actorId: plan.actorId,
    // Matches what `runFuzzyCheck` builds, so a criterion keeps one check id whether it
    // was assessed or skipped. M6 compares runs by that id; a check that renamed itself
    // when a dependency went missing would read as one check gone and another arrived.
    action: `fuzzy ${plan.request.path}`,
  };
}

/**
 * Why a fuzzy criterion cannot be assessed, or undefined when it can.
 *
 * Every branch is one line and names the thing to install or configure. A reason a user
 * cannot act on is a reason they ignore, and an unverified bucket full of those is how a
 * coverage gap becomes invisible while still being reported.
 */
function capabilityGap(
  context: BehavioralContext,
  capability: BrowserCapability | undefined,
): string | undefined {
  if (context.browser === undefined) {
    return 'no browser target is configured for this run, so no page was opened.';
  }

  if (capability?.kind === 'unavailable') return capability.detail;
  if (context.judge === undefined) return NO_JUDGE;

  return undefined;
}

/**
 * A skipped fuzzy check.
 *
 * `deterministic: false` even though no model was involved, which is worth stating.
 * The field drives `modelAssistedCheckCount`, and this criterion produced no
 * deterministic assertion either: calling it deterministic would claim the assertion
 * side reached this verdict when it never ran. Counting it on the model assisted side
 * overstates involvement by one, and overstating how much of a run was not deterministic
 * is the safe direction for a tool whose trust argument is invariant I1.
 */
function skipped(plan: BehavioralPlan, detail: string): CheckResult {
  return inconclusive({
    identity: identityFor(plan),
    title: `Acceptance criterion ${plan.criterionId}`,
    deterministic: false,
    ...(plan.locationRef === undefined ? {} : { locationRef: plan.locationRef }),
    detail: `${plan.criterionId} was not assessed: ${detail}`,
  });
}

export async function runBehavioralChecks(
  plans: readonly BehavioralPlan[],
  context: BehavioralContext,
): Promise<BehavioralRunResult> {
  const fuzzy = plans.filter((plan) => plan.mode === 'fuzzy');

  // Resolved once, and only when something needs it. A run of deterministic criteria
  // does not attempt an optional import at all.
  const capability =
    fuzzy.length > 0 && context.browser !== undefined
      ? await resolveBrowserCapability(context.browser.launcher)
      : undefined;

  const gap = capabilityGap(context, capability);

  // Said while it is happening, not only as a reason on each criterion afterwards. A
  // reader watching a run go by cannot otherwise tell that a whole family was skipped.
  if (gap !== undefined && fuzzy.length > 0) {
    context.reporter?.warn(
      `${fuzzy.length} fuzzy criterion(s) will be reported unverified: ${gap}`,
    );
  }

  const effective: BehavioralContext =
    capability?.kind === 'available' && context.browser !== undefined
      ? { ...context, browser: { ...context.browser, launcher: capability.launcher } }
      : context;

  const registry = createCheckRegistry<BehavioralContext>();
  registry.register<BehavioralPlan>('behavioral', async (plan, ctx) => {
    if (plan.mode !== 'fuzzy') return runDeterministicCheck(plan, ctx);

    // The judge is narrowed here rather than asserted. `capabilityGap` has already
    // established it is present, and writing that as a cast would make the compiler
    // believe a claim nothing rechecks.
    const judge = ctx.judge;
    if (gap !== undefined || judge === undefined) return skipped(plan, gap ?? NO_JUDGE);

    return runFuzzyCheck(plan, ctx, judge);
  });

  const results = await registry.runAll(plans, effective);

  const byCriterion = new Map(results.map((result) => [result.ruleId ?? '', result]));

  const unverified = fuzzy.flatMap((plan): UnverifiedCheck[] => {
    const entry = { requirementId: plan.requirementId, criterionId: plan.criterionId };

    if (gap !== undefined) {
      return [{ ...entry, reason: 'capability-unavailable', detail: gap }];
    }

    const result = byCriterion.get(plan.criterionId);
    if (result?.verdict !== 'inconclusive') return [];

    // The judge ran and did not settle it. A different fact from nothing having looked,
    // and the contract keeps a separate reason for it.
    return [
      {
        ...entry,
        reason: 'model-inconclusive',
        detail: result.detail ?? 'the model did not settle the criterion',
      },
    ];
  });

  return { results, unverified };
}

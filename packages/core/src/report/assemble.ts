import type {
  CheckResultRecord,
  Observation,
  ObservationCounts,
  ObservationEndpointSummary,
  RequirementResult,
  RequirementVerdict,
  RunResult,
  Severity,
  StructuralFindings,
  Summary,
  UnverifiedReason,
} from '../contracts/index.ts';
import type { Spec } from '../contracts/index.ts';
import type { CoverageGap } from '../checks/gaps.ts';

/**
 * Run assembly: every check, finding, and gap in one `RunResult`.
 *
 * RunResult is the public interface of this tool and every emitter is a projection of
 * it, so this is the only place a verdict is decided from a set of checks. The module
 * calls the rollup the rule most likely to be reimplemented subtly differently
 * elsewhere, which is why it is exported: anything that needs it calls this rather than
 * writing the three-line version that looks obviously right and is not.
 *
 * **Determinism.** Every collection is sorted before it is returned. M7.2 makes the JSON
 * a golden file and two runs over identical inputs have to produce identical bytes, so
 * ordering cannot depend on the order checks happened to finish in.
 */

/**
 * The rollup, exactly as the contract states it.
 *
 * A requirement is `verified` only with at least one check and no failures. Any fail
 * makes it `failed`. All inconclusive, or no checks at all, makes it `unverified`.
 *
 * The last clause is the one that matters and the one an optimizer would break: a
 * requirement nobody could check is not a requirement that passed. Invariant I4.
 */
export function rollUpRequirement(checks: readonly CheckResultRecord[]): {
  verdict: RequirementVerdict;
  reason: string;
} {
  if (checks.length === 0) {
    return { verdict: 'unverified', reason: 'no checks were defined for this requirement' };
  }

  const failed = checks.filter((check) => check.verdict === 'fail');
  if (failed.length > 0) {
    return {
      verdict: 'failed',
      reason: `${failed.length} of ${checks.length} check(s) failed`,
    };
  }

  const passed = checks.filter((check) => check.verdict === 'pass');
  if (passed.length === 0) {
    return {
      verdict: 'unverified',
      reason: `${checks.length} check(s) ran and none reached a verdict`,
    };
  }

  return { verdict: 'verified', reason: `${passed.length} of ${checks.length} check(s) passed` };
}

export interface AssembleInput {
  readonly runId: string;
  readonly toolVersion: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly resultVersion?: string;
  readonly spec: Spec;
  readonly specHash: string;
  readonly specFiles: readonly string[];
  readonly target: {
    readonly baseUrl?: string;
    readonly sourceRoot?: string;
    readonly commit?: string;
  };
  readonly observationRef?: string;
  /**
   * The Observation the run probed, summarized onto the result. Q6, decided 2026-08-22.
   *
   * Optional, because a run assembled without one is legitimate. Absent means the result
   * says nothing about what was observed, which is different from reporting zeroes.
   */
  readonly observation?: Observation;
  readonly checks: readonly CheckResultRecord[];
  readonly structural?: StructuralFindings;
  /** From `collectCoverageGaps`, so the three side channels are gathered once. */
  readonly gaps?: readonly CoverageGap[];
}

const EMPTY_STRUCTURAL: StructuralFindings = {
  specifiedNotObserved: [],
  observedNotSpecified: [],
  fieldMismatches: [],
};

function tallyChecks(checks: readonly CheckResultRecord[]): Summary['checks'] {
  return {
    total: checks.length,
    pass: checks.filter((check) => check.verdict === 'pass').length,
    fail: checks.filter((check) => check.verdict === 'fail').length,
    inconclusive: checks.filter((check) => check.verdict === 'inconclusive').length,
  };
}

/**
 * Severity counts over findings, which are failures. A passing check carries `info` and
 * counting it here would report a clean run as having findings.
 */
function tallyFindings(checks: readonly CheckResultRecord[]): Summary['findingsBySeverity'] {
  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  for (const check of checks) {
    if (check.verdict !== 'fail') continue;
    counts[check.severity] += 1;
  }
  return counts;
}

/**
 * Coverage: requirements with at least one non-inconclusive check, over total
 * requirements. It is not a pass rate, it is never labeled as one, and a run with no
 * requirements is 0 rather than a division by zero dressed up as perfect coverage.
 */
function coverageOf(
  requirementIds: readonly string[],
  byRequirement: ReadonlyMap<string, CheckResultRecord[]>,
): number {
  if (requirementIds.length === 0) return 0;

  const covered = requirementIds.filter((id) =>
    (byRequirement.get(id) ?? []).some((check) => check.verdict !== 'inconclusive'),
  );

  return covered.length / requirementIds.length;
}

/**
 * One reason per unverified requirement, drawn from the contract's closed set.
 *
 * A gap the run reported wins over the generic fallback, since it names something the
 * reader can act on. A requirement that is unverified with no gap recorded had checks
 * that all came back inconclusive, which is `no-verdict-reached`, and `no-checks-defined`
 * covers the requirement that had nothing to run in the first place.
 *
 * **`check-error` is no longer the fallback**, resolved as Q7 on 2026-08-22. It means
 * something threw, and it was being reported for a requirement whose checks all declined
 * to guess, which is invariant I2 working. A run that says it errored when it did not is
 * a tool describing itself as broken, and it happened five times before the closed set
 * gained a member for it. A runner that really throws still records `check-error` as a
 * gap, and that gap wins here, so the meaning it was named for is intact.
 */
function reasonsFor(
  requirements: readonly RequirementResult[],
  gapsByRequirement: ReadonlyMap<string, CoverageGap[]>,
  checkCount: ReadonlyMap<string, number>,
): { requirementId: string; reason: UnverifiedReason; detail?: string }[] {
  const entries: { requirementId: string; reason: UnverifiedReason; detail?: string }[] = [];

  for (const requirement of requirements) {
    if (requirement.verdict !== 'unverified') continue;

    const gaps = gapsByRequirement.get(requirement.requirementId) ?? [];
    const first = gaps[0];

    if (first !== undefined) {
      entries.push({
        requirementId: requirement.requirementId,
        reason: first.reason,
        detail:
          gaps.length === 1
            ? first.detail
            : `${first.detail} (${gaps.length} gaps on this requirement)`,
      });
      continue;
    }

    entries.push({
      requirementId: requirement.requirementId,
      reason:
        (checkCount.get(requirement.requirementId) ?? 0) === 0
          ? 'no-checks-defined'
          : 'no-verdict-reached',
      ...(requirement.reason === undefined ? {} : { detail: requirement.reason }),
    });
  }

  return entries;
}

/**
 * The Observation as a run remembers it, per Q6.
 *
 * Sorted by identity, like every other collection here, so two runs over identical inputs
 * produce identical bytes. The endpoint list carries the identity and `authRequired` and
 * nothing else; the reasoning for that narrowness is on the schema.
 */
function summarizeObservation(observation: Observation): {
  mode: Observation['mode'];
  counts: ObservationCounts;
  endpoints: ObservationEndpointSummary[];
  notes: Observation['notes'];
} {
  const tally = <T extends string>(values: readonly T[], key: T): number =>
    values.filter((value) => value === key).length;

  const entityOrigins = observation.entities.map((entity) => entity.origin);
  const entityConfidence = observation.entities.map((entity) => entity.confidence);
  const endpointOrigins = observation.endpoints.map((endpoint) => endpoint.origin);
  const endpointConfidence = observation.endpoints.map((endpoint) => endpoint.confidence);

  return {
    mode: observation.mode,
    notes: observation.notes,
    counts: {
      entities: {
        schema: tally(entityOrigins, 'schema'),
        inferred: tally(entityOrigins, 'inferred'),
        high: tally(entityConfidence, 'high'),
        medium: tally(entityConfidence, 'medium'),
        low: tally(entityConfidence, 'low'),
      },
      endpoints: {
        source: tally(endpointOrigins, 'source'),
        blackbox: tally(endpointOrigins, 'blackbox'),
        high: tally(endpointConfidence, 'high'),
        medium: tally(endpointConfidence, 'medium'),
        low: tally(endpointConfidence, 'low'),
      },
    },
    endpoints: observation.endpoints
      .map((endpoint) => ({
        id: endpoint.id,
        method: endpoint.method,
        path: endpoint.path,
        authRequired: endpoint.authRequired,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function assembleRun(input: AssembleInput): RunResult {
  const checks = [...input.checks].sort((left, right) => left.checkId.localeCompare(right.checkId));

  const byRequirement = new Map<string, CheckResultRecord[]>();
  for (const check of checks) {
    if (check.requirementId === undefined) continue;
    const bucket = byRequirement.get(check.requirementId) ?? [];
    bucket.push(check);
    byRequirement.set(check.requirementId, bucket);
  }

  const gapsByRequirement = new Map<string, CoverageGap[]>();
  for (const gap of input.gaps ?? []) {
    const bucket = gapsByRequirement.get(gap.requirementId) ?? [];
    bucket.push(gap);
    gapsByRequirement.set(gap.requirementId, bucket);
  }

  // Requirement order follows the spec, not the checks. A reader comparing two runs is
  // looking down the same list both times.
  const requirementIds = input.spec.requirements.map((requirement) => requirement.id);

  const requirements: RequirementResult[] = requirementIds.map((id) => {
    const own = byRequirement.get(id) ?? [];
    const { verdict, reason } = rollUpRequirement(own);

    return {
      requirementId: id,
      verdict,
      reason,
      checkIds: own.map((check) => check.checkId).sort((left, right) => left.localeCompare(right)),
    };
  });

  const checkCount = new Map(
    requirementIds.map((id) => [id, (byRequirement.get(id) ?? []).length]),
  );

  const summary: Summary = {
    requirements: {
      total: requirements.length,
      verified: requirements.filter((entry) => entry.verdict === 'verified').length,
      failed: requirements.filter((entry) => entry.verdict === 'failed').length,
      unverified: requirements.filter((entry) => entry.verdict === 'unverified').length,
    },
    checks: tallyChecks(checks),
    coverage: coverageOf(requirementIds, byRequirement),
    findingsBySeverity: tallyFindings(checks),
    modelAssistedCheckCount: checks.filter((check) => !check.deterministic).length,
  };

  const unverifiedReasons = reasonsFor(requirements, gapsByRequirement, checkCount).sort(
    (left, right) => left.requirementId.localeCompare(right.requirementId),
  );

  return {
    // 0.3 since the M3.8 answer added `requestRef` and `suggestion`, after 0.2 added the
    // observation summary at Q6. Both additive, so the contract's own rule bumps the minor.
    resultVersion: input.resultVersion ?? '0.4',
    runId: input.runId,
    toolVersion: input.toolVersion,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    spec: {
      hash: input.specHash,
      specVersion: input.spec.specVersion,
      files: [...input.specFiles].sort((left, right) => left.localeCompare(right)),
    },
    target: {
      ...(input.target.baseUrl === undefined ? {} : { baseUrl: input.target.baseUrl }),
      ...(input.target.sourceRoot === undefined ? {} : { sourceRoot: input.target.sourceRoot }),
      ...(input.target.commit === undefined ? {} : { commit: input.target.commit }),
    },
    ...(input.observationRef === undefined
      ? {}
      : {
          observation: {
            ref: input.observationRef,
            ...(input.observation === undefined ? {} : summarizeObservation(input.observation)),
          },
        }),
    requirements,
    checks,
    structural: input.structural ?? EMPTY_STRUCTURAL,
    summary,
    unverifiedReasons,
  };
}

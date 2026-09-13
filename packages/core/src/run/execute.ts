import { resolveBrowserCapability } from '../checks/behavioral/browser.ts';
import { planBehavioralChecks } from '../checks/behavioral/plan.ts';
import { runBehavioralChecks } from '../checks/behavioral/run.ts';
import type { BehavioralPlan } from '../checks/behavioral/types.ts';
import { planAccessChecks } from '../checks/access/plan.ts';
import { runAccessChecks } from '../checks/access/run.ts';
import type { AccessCheckPlan } from '../checks/access/plan.ts';
import { collectCoverageGaps } from '../checks/gaps.ts';
import type { CheckResultRecord, Evidence, RunResult } from '../contracts/index.ts';
import { diffSpecObservation } from '../diff/spec-observation.ts';
import type { EvidenceWriter } from '../evidence/capture.ts';
import { probe } from '../probe/probe.ts';
import { assembleRun } from '../report/assemble.ts';
import type { Reporter } from '../report/reporter.ts';
import type { PruneReport } from '../store/prune.ts';
import type { SaveReport, Store } from '../store/store.ts';
import type { CapabilityReport } from '../target/context.ts';
import { createTargetContext } from '../target/context.ts';
import { isRefusal, mutatingChecksAllowed, resetFixtures } from '../target/fixtures.ts';
import { isTransportError } from '../target/request.ts';
import { RunFatalError, type RunInput, type RunPorts } from './types.ts';

/** `RUN-20260818-180338`, derived from the injected clock rather than read from one. */
export function runIdFrom(instant: string): string {
  return `RUN-${stamp(instant)}`;
}

/** The run's Observation, named off the same instant so the pair reads as one run. */
export function observationIdFrom(instant: string): string {
  return `OBS-${stamp(instant)}`;
}

/**
 * `20260818-180338` from an ISO instant: date, then hours, minutes, and seconds.
 *
 * Seconds are in it because the store keys runs by id and refuses a duplicate rather than
 * overwriting one. At minute resolution two runs a few seconds apart collided, which is
 * exactly what happens when somebody checks, fixes something, and checks again, and is
 * also what the S7 exit criterion does on purpose.
 */
function stamp(instant: string): string {
  const digits = instant.replace(/\D/g, '');
  return `${digits.slice(0, 8)}-${digits.slice(8, 14)}`;
}

/**
 * The capability report, said out loud at the start.
 *
 * `createTargetContext` already phrases every gap as what will not be checked, and the
 * contract calls those lines something a surface prints verbatim, so they are printed
 * verbatim. The available half is stated too: a reader seeing only warnings cannot tell
 * a clean setup from an unreported gap.
 */
function reportCapabilities(
  capabilities: CapabilityReport,
  browserAvailable: boolean,
  reporter: Reporter,
): void {
  reporter.step('Capabilities');
  reporter.info(`target: ${capabilities.baseUrl ?? 'not configured'}`);
  reporter.info(
    `source: ${
      capabilities.sourceRoot === undefined
        ? 'not configured'
        : `${capabilities.sourceRoot}${capabilities.sourcePresent ? '' : ' (missing)'}`
    }`,
  );
  reporter.info(
    capabilities.actorIds.length === 0
      ? 'actors: none resolved'
      : `actors: ${capabilities.actorIds.join(', ')}`,
  );
  reporter.info(`fixtures: ${capabilities.fixturesAvailable ? 'available' : 'refused'}`);
  reporter.info(`browser: ${browserAvailable ? 'available' : 'not installed'}`);

  for (const warning of capabilities.warnings) reporter.warn(warning);

  if (!browserAvailable) {
    reporter.warn(
      'Playwright is not installed, so any criterion with mode fuzzy will be reported unverified with reason capability-unavailable. Install playwright to enable it.',
    );
  }
}

/**
 * The injected writer, plus a list of what it wrote.
 *
 * The Evidence records exist inside the session layer and reach a CheckResult as ids
 * only, so this is how the run gets the records themselves without changing a signature
 * owned by M3 or M5. The writer is the caller's: a runner that streams evidence elsewhere
 * supplies its own and still gets the records collected for whatever it does next.
 */
function recordingWriter(real: EvidenceWriter, into: Evidence[]): EvidenceWriter {
  return {
    write(capture) {
      real.write(capture);
      into.push(capture.evidence);
    },
  };
}

/** What retention removed, or nothing at all when it removed nothing. */
function describePrune(report: PruneReport): string | undefined {
  const { runsRemoved, evidenceRemoved, bodiesDeleted } = report;
  if (runsRemoved.length === 0 && evidenceRemoved.length === 0) return undefined;

  const parts = [
    `kept the last ${report.policy.keepRuns} run(s) and the evidence for ${report.policy.keepEvidence}`,
  ];

  if (runsRemoved.length > 0) parts.push(`removed ${runsRemoved.join(', ')}`);
  if (evidenceRemoved.length > 0) {
    parts.push(
      `dropped ${evidenceRemoved.length} evidence record(s) and ${bodiesDeleted.length} body file(s)`,
    );
  }

  return `retention: ${parts.join('; ')}`;
}

/**
 * Records the run, and says what that cost. Never throws.
 *
 * A store that will not write does not fail the run. The report is the product and it has
 * already been produced by then; turning a completed run into an error because a database
 * file could not be written would report the wrong thing about the application. It is a
 * warning, and a loud one, because a user who never notices will wonder later why
 * `specgate diff` has nothing to compare.
 *
 * The store is not closed here. It was opened by whoever passed it and closing something
 * this function did not open would surprise the next caller to reuse one.
 */
function record(
  store: Store,
  result: RunResult,
  evidence: readonly Evidence[],
  reporter: Reporter,
): void {
  let saved: SaveReport;

  try {
    saved = store.saveRun(result, evidence);
  } catch (error) {
    reporter.warn(
      `the run was not recorded, so "specgate diff" and "specgate report" will not see it: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  reporter.info(`recorded ${saved.runId} with ${saved.evidenceRecorded} evidence record(s)`);

  if (saved.bodiesMissing.length > 0) {
    reporter.warn(
      `${saved.bodiesMissing.length} evidence record(s) name a body file that is not on disk: ${saved.bodiesMissing.join(', ')}`,
    );
  }

  // Pruning is reported rather than done silently, which is the module's rule and the
  // reason the store hands the report back with the save.
  const pruned = describePrune(saved.pruned);
  if (pruned !== undefined) reporter.info(pruned);
}

/**
 * One run, from a loaded spec to a RunResult.
 *
 * **Nothing here decides a verdict.** `planAccessChecks` and `planBehavioralChecks` decide
 * what can be checked, the runners decide the verdicts, and `assembleRun` rolls them up.
 * This function moves data between them.
 *
 * **It does not render, does not compute an exit code, and does not exit.** Those belong to
 * a surface. It records the run when it was given a store and not otherwise.
 *
 * **The capability report comes first, before any work.** A run that checks almost nothing
 * and exits zero is the failure mode the report exists for: a reader seeing "no findings"
 * cannot tell that from a clean bill of health unless the tool says what it could not do.
 * Emitting it afterwards would be emitting it too late to be believed.
 *
 * Throws `RunFatalError` for the two conditions under which no RunResult exists: a target
 * with no base URL, and a target that could not be reached at all.
 */
export async function executeRun(input: RunInput, ports: RunPorts): Promise<RunResult> {
  const { config, cwd, env, spec: loaded, toolVersion } = input;
  const { deps, reporter } = ports;

  const startedAt = deps.now();
  const evidence: Evidence[] = [];
  const target = createTargetContext(config, loaded.spec, {
    env,
    deps,
    cwd,
    writer: recordingWriter(ports.evidence, evidence),
    ...(ports.http === undefined ? {} : { client: ports.http }),
  });
  const browser = await resolveBrowserCapability();
  reportCapabilities(target.capabilities, browser.kind === 'available', reporter);

  const baseUrl = config.target.baseUrl;
  if (baseUrl === undefined) {
    throw new RunFatalError({
      code: 2,
      summary: 'the target has no base URL',
      where: 'target.baseUrl',
      reason: 'A check issues requests, so it needs somewhere to send them.',
      suggestion: 'Set target.baseUrl in the config, for example http://localhost:3000.',
    });
  }

  // One request before anything else, so an unreachable target is reported as one rather
  // than as a report full of inconclusive checks.
  reporter.step(`Reaching ${baseUrl}`);
  // Unauthenticated on purpose. Whether the root answers 200 or 401 is a fact about the
  // application; whether anything answered at all is the fact this is asking for.
  const reachability = await target.client.send({ method: 'GET', path: '/' }, { kind: 'none' });
  if (isTransportError(reachability)) {
    throw new RunFatalError({
      code: 3,
      summary: 'could not reach the target',
      where: baseUrl,
      reason: reachability.message,
      suggestion: 'Start the application, or correct target.baseUrl in the config.',
    });
  }

  reporter.step('Probing the target');
  // The source root travels with the base URL. Without it the probe is black box on
  // every run whatever the config said, so no endpoint carries a handler reference and
  // no finding can cite a file.
  const sourceRoot = config.target.sourceRoot;
  const observation = await probe(
    {
      config: { target: { baseUrl, ...(sourceRoot === undefined ? {} : { sourceRoot }) } },
      sessions: target.sessions,
    },
    { deps, baseUrl, cwd, reporter },
  );
  reporter.info(
    `${observation.endpoints.length} endpoint(s) and ${observation.entities.length} entity(ies) observed`,
  );

  const planning = {
    actorIds: new Set(target.sessions.keys()),
    resources: config.resources,
  };

  reporter.step('Planning checks');
  const access = planAccessChecks(loaded.spec, loaded.conditions, observation, planning);
  const behavioral = planBehavioralChecks(loaded.spec, observation, planning);
  reporter.info(
    `${access.plans.length} access check(s) and ${behavioral.plans.length} behavioral check(s) planned`,
  );

  reporter.step('Running checks');
  /**
   * The reset the disposability gate permits.
   *
   * M3.7 built the interlock and gave the runner a `reset` to call between mutating
   * checks, and no caller ever supplied one, so no real run reset anything. The corpus
   * paid for it: on one application a destructive access check deleted the record, and
   * the criterion that would have caught the same defect reported that nothing could
   * change; on another a later anonymous delete passed with a 404 because the record was
   * already gone.
   *
   * It lives here rather than in a caller precisely so the next caller cannot omit it.
   * That omission is the defect this module exists to stop recurring.
   *
   * A reset that fails is reported rather than swallowed. `runAccessChecks` already stops
   * the remaining mutating checks when one fails, and between the families the honest
   * thing is to say so out loud, because everything after it ran against a state nobody
   * established.
   */
  const canMutate = mutatingChecksAllowed(config);
  const reset = canMutate
    ? async (): Promise<void> => {
        const outcome = await resetFixtures(config, { cwd });
        if (isRefusal(outcome)) throw new Error(outcome.message);
        if (outcome.exitCode !== 0) {
          throw new Error(`the reset command exited ${outcome.exitCode}`);
        }
      }
    : undefined;

  const accessResults = await runAccessChecks(access.plans as AccessCheckPlan[], {
    sessions: target.sessions,
    mutation: { allowed: canMutate, ...(reset === undefined ? {} : { reset }) },
    // A denied delete that succeeds and returns nothing is settled by reading the record,
    // never as the actor the rule says must be refused.
    ...(config.stateActor === undefined ? {} : { stateActorId: config.stateActor }),
    reporter,
  });

  // Between the families, not only within one. An access check that deleted a record
  // changes what every criterion after it can observe.
  if (reset !== undefined && access.plans.some((plan) => plan.mutates)) {
    try {
      await reset();
    } catch (cause) {
      reporter.warn(
        `The reset between the access checks and the acceptance criteria did not complete, so every criterion below ran against a state this run did not establish: ${
          cause instanceof Error ? cause.message : 'the reset command failed'
        }`,
      );
    }
  }

  const { results: behavioralResults, unverified } = await runBehavioralChecks(
    behavioral.plans as BehavioralPlan[],
    {
      sessions: target.sessions,
      ...(config.stateActor === undefined ? {} : { stateActorId: config.stateActor }),
      browser: { baseUrl },
      ...(ports.judge === undefined ? {} : { judge: ports.judge }),
      ...(canMutate
        ? { mutation: { allowed: true } }
        : { mutation: { allowed: false, reason: 'the target is not marked disposable' } }),
      reporter,
    },
  );

  const result = assembleRun({
    runId: runIdFrom(startedAt),
    toolVersion,
    startedAt,
    finishedAt: deps.now(),
    spec: loaded.spec,
    specHash: loaded.hash,
    specFiles: loaded.files,
    observationRef: observationIdFrom(startedAt),
    observation,
    target: {
      baseUrl,
      ...(config.target.sourceRoot === undefined ? {} : { sourceRoot: config.target.sourceRoot }),
    },
    checks: [...accessResults, ...behavioralResults] as CheckResultRecord[],
    structural: diffSpecObservation(loaded.spec, observation, config.resources),
    // Three side channels through one collector, so a caller that remembered two cannot
    // silently drop the third.
    gaps: collectCoverageGaps({
      accessUnplannable: access.unplannable,
      behavioralUnplannable: behavioral.unplannable,
      behavioralUnverified: unverified,
    }),
  });

  if (ports.store !== undefined) {
    reporter.step('Recording the run');
    record(ports.store, result, evidence, reporter);
  }

  return result;
}

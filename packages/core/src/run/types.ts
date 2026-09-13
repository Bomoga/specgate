import type { Judge } from '../checks/behavioral/judge.ts';
import type { RunResult } from '../contracts/index.ts';
import type { EvidenceWriter } from '../evidence/capture.ts';
import type { Reporter } from '../report/reporter.ts';
import type { LoadedSpec } from '../spec/load.ts';
import type { Store } from '../store/store.ts';
import type { TargetConfig } from '../target/config.ts';
import type { Deps } from '../target/deps.ts';
import type { HttpClient } from '../target/request.ts';

/**
 * The run, as something other than the CLI can execute.
 *
 * **Why this exists.** `runCheck` in `packages/cli` is the actual run, and `core` exports no
 * equivalent, so a runner wanting to execute one would have to reimplement the sequence.
 * Reimplementing it is not a theoretical cost: the reset between check families was built at
 * M3.7, no caller supplied one for months, and the corpus paid for it twice before `check.ts`
 * wired it up. A second caller writing the sequence again is a second caller with that defect.
 *
 * **This is a refactor.** No verdict moves. A verdict that moves is a bug in this module.
 *
 * **No filesystem port, per D32.** Every runner target has a real filesystem, and the
 * abstraction earns its keep only for hosted execution, which the platform scope names as out
 * of scope and to be refused. `cwd` stays on `RunInput` and file reads stay on `node:fs`.
 */

/**
 * The six ports, three of which are optional because the code already treats them that way.
 *
 * **`store` is optional by design.** A runner that submits to the control plane has no local
 * store to write, and a store that will not write has never failed a run: the report is the
 * product and it has already been produced by the time storage is attempted.
 *
 * **`judge` and `http` are optional, and the module file declares them required.** That is a
 * conflict with the code as found, and `04-CONVENTIONS.md` says to trust the code about what
 * exists and the plan about what is intended. The intent is that both are injectable, and they
 * are. Requiring them would change behavior:
 *
 * - No judge is supplied anywhere outside tests today, so every real run reports a fuzzy
 *   criterion as `unverified` with reason `capability-unavailable`. Forcing a caller to supply
 *   one would change an unverified reason, which this module's Do Not list forbids outright.
 * - `createTargetContext` already accepts an optional `client` and builds one from the config
 *   when absent. Requiring it here would move that construction to every caller for no gain.
 */
export interface RunPorts {
  /** Absent for a runner that submits rather than stores. A store that will not write warns. */
  readonly store?: Store;
  readonly evidence: EvidenceWriter;
  readonly reporter: Reporter;
  readonly deps: Deps;
  /** Absent means fuzzy criteria stay `unverified` with `capability-unavailable`, as today. */
  readonly judge?: Judge;
  /** Absent means one is built from `config.target.baseUrl`, as `createTargetContext` does. */
  readonly http?: HttpClient;
}

/**
 * Everything a run needs that is not a port.
 *
 * `toolVersion` is passed in rather than read, because `core` has no version of its own to
 * report and the constant that reaches a user lives in the CLI. It lands in `toolVersion` on
 * the RunResult and in every SARIF document, so a wrong one is visible to a stranger.
 */
export interface RunInput {
  readonly spec: LoadedSpec;
  readonly config: TargetConfig;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Still present: file reads stay on `node:fs` per D32. */
  readonly cwd: string;
  readonly toolVersion: string;
}

/**
 * The two conditions under which no RunResult exists.
 *
 * **Why this throws rather than returning a union.** Rule R4 reserves throwing for programmer
 * error and for the fatal conditions `03-CONTRACTS.md` defines as exit codes 2 and 3, and these
 * are exactly those. A check that cannot reach a verdict returns `inconclusive` and is not this;
 * this is the run not happening at all. Returning a union instead would put a discriminant check
 * at a call site that has nothing useful to do with it except rethrow.
 *
 * **The fields are presentation input, not presentation.** `core` writes no output, per R5. It
 * hands back what the surface needs to say and the surface decides how to say it, the same way
 * a capability warning is a string `core` produces and the CLI prints verbatim.
 */
export class RunFatalError extends Error {
  /** 2: the spec or configuration is unusable. 3: the target could not be reached at all. */
  readonly code: 2 | 3;
  /** Where the problem is: a path, a URL, or a config key. */
  readonly where: string;
  /** Why it is a problem, when that is not obvious from the summary. */
  readonly reason: string | undefined;
  /** What the reader could do about it. */
  readonly suggestion: string | undefined;

  constructor(init: {
    code: 2 | 3;
    summary: string;
    where: string;
    reason?: string;
    suggestion?: string;
  }) {
    super(init.summary);
    this.name = 'RunFatalError';
    this.code = init.code;
    this.where = init.where;
    this.reason = init.reason;
    this.suggestion = init.suggestion;
  }
}

/** Narrows an unknown caught value to the fatal the run throws. */
export function isRunFatal(value: unknown): value is RunFatalError {
  return value instanceof RunFatalError;
}

/**
 * Executes one run and returns its result.
 *
 * Emits progress through `ports.reporter`, writes evidence through `ports.evidence`, and
 * records the run when given a `store`. It does not render, does not compute an exit code, and
 * does not write to a store it was not given.
 *
 * Throws `RunFatalError` when no RunResult can exist.
 */
export type ExecuteRun = (input: RunInput, ports: RunPorts) => Promise<RunResult>;

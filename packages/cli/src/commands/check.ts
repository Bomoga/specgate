import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import {
  computeExitCode,
  createEvidenceWriter,
  executeRun,
  isLoadFailure,
  isRunFatal,
  loadSpec,
  openStore,
  renderJson,
  renderJunit,
  renderSarif,
  renderText,
  systemDeps,
  type Deps,
  type Reporter,
  type RunResult,
  type Store,
  type TargetConfig,
} from '@specgate/core';

import type { Stream } from '../reporter.ts';
import { fromDiagnostic, present, presentAll } from '../errors.ts';
import { CLI_VERSION } from '../program.ts';
import type { Settings } from '../settings.ts';
import { DEFAULT_SPEC_GLOB } from './validate.ts';

/**
 * `specgate check`: the full run, and the only command that produces a RunResult.
 *
 * **The run itself is not here.** `executeRun` in `core` owns the sequence as of P1, so
 * that a runner can execute one without reimplementing it. What is left in this file is
 * what a surface owes a user: turning arguments into an input, opening the things the run
 * writes through, rendering the result, and applying an exit code it was given.
 *
 * **Exit codes.** 0 and 1 come from `computeExitCode` and are applied without being
 * recomputed. 2 and 3 describe conditions under which no RunResult exists, and reach here
 * two ways: an unusable spec or configuration, which this file settles before calling the
 * run, and a `RunFatalError` the run throws for a target with no base URL or one that
 * could not be reached at all.
 *
 * **Every run is recorded.** `specgate diff` and `specgate report` read runs out of
 * `.specgate/runs.db` and nothing else puts one there, so a check that did not store its
 * result would leave the sixth step of the success sequence unreachable. It is not behind
 * a flag: the command table has no flag for it, and adding one would change the surface.
 *
 * **A store that will not open does not fail the run.** It is a warning here for the same
 * reason a store that will not write is a warning inside the run: the report is the
 * product, and turning a completed run into an error because a database file could not be
 * written would report the wrong thing about the application.
 */

export interface CheckOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Spec paths from the command line. Empty means the default glob. */
  readonly paths: readonly string[];
  readonly config: TargetConfig | undefined;
  readonly configPath: string;
  readonly settings: Settings;
  readonly stdout: Stream;
  readonly stderr: Stream;
  readonly reporter: Reporter;
  /** Whether stdout is a terminal, so the text report can be coloured. */
  readonly color?: boolean;
  /** Adds a stack trace to any error this prints. */
  readonly verbose?: boolean;
  /** Injected so a test can pin the clock and the identifier source, per rule R6. */
  readonly deps?: Deps;
}

function render(result: RunResult, format: Settings['format']['value'], color: boolean): string {
  if (format === 'json') return renderJson(result);
  if (format === 'sarif') return renderSarif(result);
  if (format === 'junit') return renderJunit(result);
  // No Observation argument since Q6. The result carries a summary of its own, so the
  // text report is a projection of a RunResult again and `specgate report` renders the same
  // section from a stored run.
  return renderText(result, { color });
}

/**
 * Opens the run store, or says why it could not and carries on without one.
 *
 * The open is guarded as well as the write. A database written by a newer build is
 * refused rather than opened, and that refusal must not take a finished run with it.
 */
function openStoreOrWarn(cwd: string, reporter: Reporter): Store | undefined {
  try {
    return openStore(cwd);
  } catch (error) {
    reporter.warn(
      `the run was not recorded, so "specgate diff" and "specgate report" will not see it: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

export async function runCheck(options: CheckOptions): Promise<number> {
  const { cwd, env, settings, stdout, stderr, reporter } = options;
  const deps = options.deps ?? systemDeps();
  const config = options.config;
  const presentTo = { stderr, ...(options.verbose === true ? { verbose: true } : {}) };

  // Everything that means no run can happen is settled first, so nothing below has to
  // ask whether it has a target.
  if (config === undefined) {
    return present(
      {
        code: 2,
        summary: 'no configuration was found',
        where: options.configPath,
        suggestion: 'Run "specgate init" to write one, or pass --config with the path to yours.',
      },
      presentTo,
    );
  }

  const requested = options.paths.length > 0 ? options.paths : [DEFAULT_SPEC_GLOB];
  const loaded = loadSpec(requested, { cwd });
  if (isLoadFailure(loaded)) {
    if (loaded.error.diagnostics.length === 0) {
      return present(
        {
          code: 2,
          summary: loaded.error.message,
          where: requested.join(', '),
          suggestion: 'Run "specgate validate" to see what the loader looked for.',
        },
        presentTo,
      );
    }
    return presentAll(
      loaded.error.diagnostics.map((diagnostic) =>
        fromDiagnostic(diagnostic, loaded.error.message),
      ),
      presentTo,
    );
  }

  const store = openStoreOrWarn(cwd, reporter);

  let result: RunResult;
  try {
    result = await executeRun(
      { spec: loaded, config, env, cwd, toolVersion: CLI_VERSION },
      {
        evidence: createEvidenceWriter({ cwd }),
        reporter,
        deps,
        ...(store === undefined ? {} : { store }),
      },
    );
  } catch (error) {
    // The two conditions under which no RunResult exists. The run decided the code and
    // the wording; this turns them into output, which is the half `core` does not do.
    if (isRunFatal(error)) {
      return present(
        {
          code: error.code,
          summary: error.message,
          // A config key reaches here without a file in front of it, because the run does
          // not know which file the config came from and this does.
          where: error.code === 2 ? `${options.configPath}, at ${error.where}` : error.where,
          ...(error.reason === undefined ? {} : { reason: error.reason }),
          ...(error.suggestion === undefined ? {} : { suggestion: error.suggestion }),
        },
        presentTo,
      );
    }
    throw error;
  } finally {
    store?.close();
  }

  const document = render(result, settings.format.value, options.color === true);
  const outPath = settings.out.value;

  if (outPath === undefined) {
    stdout.write(document);
  } else {
    const absolute = isAbsolute(outPath) ? outPath : resolve(cwd, outPath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, document, 'utf8');
    reporter.info(`report written to ${outPath}`);
  }

  // Computed by core, applied here, never recomputed. The module says so and so does
  // rule R5.
  return computeExitCode(result, {
    failOn: settings.failOn.value,
    failOnUnverified: settings.failOnUnverified.value,
  });
}

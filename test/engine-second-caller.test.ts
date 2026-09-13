import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  createEvidenceWriter,
  executeRun,
  isConfigFailure,
  isLoadFailure,
  loadConfig,
  loadSpec,
  renderJson,
  silentReporter,
  systemDeps,
  type TargetConfig,
} from '../packages/core/src/index.ts';
import { afterEach, describe, expect, it } from 'vitest';

import { CLI_VERSION } from '../packages/cli/src/program.ts';
import {
  ALL_DEFECTS_ON,
  ENV,
  FIXTURE_SPEC,
  runCli,
  startLedger,
  stopLedgers,
  workspace,
  writeConfig,
} from './support/ledger.ts';

/**
 * The second caller the P1 exit criterion asks for.
 *
 * **What this proves.** `executeRun` is the run, and the command adds rendering and an
 * exit code to it and nothing else. A second caller drifting from the command is the
 * failure this stage exists to prevent, and it is not hypothetical: the reset between
 * mutating checks existed for months with no caller supplying one, because the sequence
 * lived somewhere a second caller would have had to copy it from.
 *
 * **Byte identity, after normalizing four things that cannot match and say nothing about
 * the engine.** The exit criterion asks for byte identity and this is as close as the
 * harness reaches, so the gap is stated rather than hidden:
 *
 * - `runId`, `observationRef`, `startedAt`, and `finishedAt` all derive from the clock.
 *   The command drives `main`, which takes no injected `Deps`, so the two runs cannot
 *   share an instant. Injecting a clock through `main` would be a CLI surface change.
 * - The base URL differs because the run mutates the fixture, so the second pass needs a
 *   freshly started one, and the harness picks a free port rather than a fixed one.
 *
 * Everything else is compared verbatim: every verdict, every severity, every unverified
 * reason, every check identifier, the structural diff, and the coverage gaps. A rename or
 * a dropped check family fails this.
 */

afterEach(async () => {
  await stopLedgers();
});

function configFor(dir: string): TargetConfig {
  const loaded = loadConfig(undefined, dir);
  if (isConfigFailure(loaded)) throw new Error(loaded.error.message);
  return loaded.config;
}

/** Replaces what two runs in two processes against two ports cannot share. */
function normalize(document: string, baseUrl: string): string {
  return (
    document
      .split(baseUrl)
      .join('http://target')
      // By value rather than by key. The Observation carries its own identifier under
      // `ref` as well as under `observationRef` on the result, and keying on the field name
      // missed the second one, which is exactly the sort of near miss this test is for.
      .replace(/"RUN-[^"]*"/g, '"RUN-PINNED"')
      .replace(/"OBS-[^"]*"/g, '"OBS-PINNED"')
      .replace(/"(startedAt|finishedAt)":\s*"[^"]*"/g, '"$1":"PINNED"')
  );
}

describe('executeRun is the run, and the command only renders it', () => {
  it('produces the same RunResult through the command and through a direct call', async () => {
    // The command's path, against its own fixture instance.
    const cliDir = workspace();
    const cliUrl = await startLedger(ALL_DEFECTS_ON);
    writeConfig(cliDir, cliUrl);
    copyFileSync(FIXTURE_SPEC, join(cliDir, 'spec', 'ledger.spec.yaml'));

    const cli = await runCli(cliDir, ['check', '--format', 'json']);
    // The fixture is deliberately defective, so this is the direction that breaks
    // silently if the extraction dropped a check family.
    expect(cli.code).toBe(1);

    await stopLedgers();

    // The second caller's path, against a fresh instance so it sees the same state the
    // command saw rather than what the command left behind.
    const directDir = workspace();
    const directUrl = await startLedger(ALL_DEFECTS_ON);
    writeConfig(directDir, directUrl);
    copyFileSync(FIXTURE_SPEC, join(directDir, 'spec', 'ledger.spec.yaml'));

    const loaded = loadSpec(['spec/*.spec.yaml'], { cwd: directDir });
    if (isLoadFailure(loaded)) throw new Error('the fixture spec did not load');

    const result = await executeRun(
      {
        spec: loaded,
        config: configFor(directDir),
        env: ENV,
        cwd: directDir,
        toolVersion: CLI_VERSION,
      },
      {
        // In memory ports: no store, and progress goes nowhere. This is the shape a
        // runner submitting to a control plane has.
        evidence: createEvidenceWriter({ cwd: directDir }),
        reporter: silentReporter,
        deps: systemDeps(),
      },
    );

    expect(normalize(renderJson(result), directUrl)).toBe(normalize(cli.out, cliUrl));
  });

  it('writes no store when it was given none', async () => {
    // The port is optional because a runner that submits has no local store, and the Do
    // Not list says the run must never write to one it was not given.
    const dir = workspace();
    const baseUrl = await startLedger(ALL_DEFECTS_ON);
    writeConfig(dir, baseUrl);
    copyFileSync(FIXTURE_SPEC, join(dir, 'spec', 'ledger.spec.yaml'));

    const loaded = loadSpec(['spec/*.spec.yaml'], { cwd: dir });
    if (isLoadFailure(loaded)) throw new Error('the fixture spec did not load');

    await executeRun(
      {
        spec: loaded,
        config: configFor(dir),
        env: ENV,
        cwd: dir,
        toolVersion: CLI_VERSION,
      },
      {
        evidence: createEvidenceWriter({ cwd: dir }),
        reporter: silentReporter,
        deps: systemDeps(),
      },
    );

    expect(existsSync(join(dir, '.specgate', 'runs.db'))).toBe(false);
  });
});

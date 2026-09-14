import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Evidence, RunResult } from '../contracts/index.ts';
import { DEFAULT_LIST_LIMIT, openStore, type Store } from './store.ts';
import { DEFAULT_EVIDENCE_DIR } from '../evidence/capture.ts';
import { addressOf, resolveBodyPath } from '../evidence/address.ts';

/**
 * A real SQLite file in a temp directory, and real body files beside it, because half of
 * what `saveRun` reports is whether the database and the filesystem agree.
 */
let dir: string;
const stores: Store[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'specgate-store-save-'));
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  rmSync(dir, { recursive: true, force: true });
});

function open(at = dir): Store {
  const store = openStore(at);
  stores.push(store);
  return store;
}

function run(overrides: Partial<RunResult> = {}): RunResult {
  return {
    resultVersion: '0.1',
    runId: 'RUN-20260818-0001',
    toolVersion: '0.1.0',
    startedAt: '2026-08-18T00:00:00Z',
    finishedAt: '2026-08-18T00:00:10Z',
    spec: { hash: 'sha256:abc', specVersion: '0.1', files: ['spec/app.spec.yaml'] },
    target: { baseUrl: 'http://127.0.0.1:3000' },
    requirements: [
      { requirementId: 'REQ-001', verdict: 'verified', reason: 'ok', checkIds: ['CHK-a'] },
    ],
    checks: [
      {
        checkId: 'CHK-a',
        type: 'access',
        requirementId: 'REQ-001',
        verdict: 'pass',
        deterministic: true,
        severity: 'info',
        title: 'A check',
        evidence: ['EV-1'],
      },
    ],
    structural: { specifiedNotObserved: [], observedNotSpecified: [], fieldMismatches: [] },
    summary: {
      requirements: { total: 1, verified: 1, failed: 0, unverified: 0 },
      checks: { total: 1, pass: 1, fail: 0, inconclusive: 0 },
      coverage: 1,
      findingsBySeverity: { high: 0, medium: 0, low: 0, info: 0 },
      modelAssistedCheckCount: 0,
    },
    unverifiedReasons: [],
    ...overrides,
  } as RunResult;
}

/** A content address, per D51. Derived from a seed so a test can name one twice. */
function addressFor(seed: string): string {
  return addressOf(seed);
}

function evidence(id = 'EV-1', bodyRef = addressFor('EV-1')): Evidence {
  return {
    id,
    kind: 'http',
    capturedAt: '2026-08-18T00:00:05Z',
    actorId: 'owner',
    request: { method: 'GET', url: '/api/x', headers: { authorization: '[redacted]' } },
    response: { status: 200, headers: {}, bodyRef, truncated: false },
    redactions: ['request.headers.authorization'],
  } as Evidence;
}

/** Puts a body where the capture writer would have. */
function writeBody(bodyRef: string): void {
  const target = resolveBodyPath(bodyRef, { cwd: dir, evidenceDir: DEFAULT_EVIDENCE_DIR });
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, '{"request":{},"response":{}}\n', 'utf8');
}

describe('saving a run', () => {
  it('stores the run and reads it back unchanged', () => {
    const store = open();
    const original = run();

    store.saveRun(original, []);

    expect(store.getRun(original.runId)).toStrictEqual(original);
  });

  it('returns null for a run that was never stored', () => {
    expect(open().getRun('RUN-nothing')).toBeNull();
  });

  it('records every evidence record it was given', () => {
    const store = open();
    writeBody(addressFor('EV-1'));

    const report = store.saveRun(run(), [evidence()]);

    expect(report.evidenceRecorded).toBe(1);
    expect(report.bodiesMissing).toStrictEqual([]);
  });

  it('reports a body that is not on disk rather than implying one exists', () => {
    // A run assembled without an evidence writer is legitimate, and so is one whose
    // bodies were pruned. Claiming the body is there is what would not be.
    const report = open().saveRun(run(), [evidence('EV-1', addressFor('EV-1'))]);

    expect(report.evidenceRecorded).toBe(1);
    expect(report.bodiesMissing).toStrictEqual(['EV-1']);
  });

  it('writes no body of its own', () => {
    // The writer in M2 already wrote it, redacted, at capture time. A store that
    // re-serialized a body it never read would be inventing content, against rule R8.
    const store = open();
    store.saveRun(run(), [evidence('EV-1', addressFor('EV-1'))]);

    // Still missing after the save, because saving is not writing.
    expect(
      store.saveRun(run({ runId: 'RUN-20260818-0002' }), [evidence()]).bodiesMissing,
    ).toStrictEqual(['EV-1']);
  });

  it('refuses a duplicate run id rather than overwriting history', () => {
    // The one thing a delta store must not do. Run ids come off the clock, so two runs
    // close together can collide, and the message says so.
    const store = open();
    store.saveRun(run(), []);

    expect(() => store.saveRun(run(), [])).toThrow(/already stored/);
    expect(() => store.saveRun(run(), [])).toThrow(/nothing is overwritten/);
  });

  it('refuses evidence that does not match the contract, before writing anything', () => {
    const store = open();
    const broken = { ...evidence(), kind: 'not-a-kind' } as unknown as Evidence;

    expect(() => store.saveRun(run(), [evidence('EV-1'), broken])).toThrow(/Evidence contract/);
    expect(store.getRun('RUN-20260818-0001')).toBeNull();
  });

  it('rolls the run back when an evidence row fails partway through the write', () => {
    // The atomicity test, and it has to fail *inside* the transaction to be one. Two
    // records sharing an id pass validation and then collide on the primary key at the
    // second insert, after the run row has already gone in. Without the transaction the
    // run survives with half its evidence, which would look complete to getRun and be
    // missing the thing a finding cites.
    const store = open();

    expect(() => store.saveRun(run(), [evidence('EV-1'), evidence('EV-1')])).toThrow(
      /UNIQUE|PRIMARY KEY/i,
    );
    expect(store.getRun('RUN-20260818-0001')).toBeNull();
  });

  it('refuses a run that does not match the contract', () => {
    const store = open();
    const broken = { ...run(), summary: undefined } as unknown as RunResult;

    expect(() => store.saveRun(broken, [])).toThrow(/RunResult contract/);
  });

  it('survives a store being closed and reopened', () => {
    // The point of a store. A run that only existed in one process would be a cache.
    open().saveRun(run(), []);
    for (const store of stores.splice(0)) store.close();

    expect(open().getRun('RUN-20260818-0001')?.runId).toBe('RUN-20260818-0001');
  });
});

describe('listing runs', () => {
  function save(store: Store, runId: string, startedAt: string, target?: string): void {
    store.saveRun(
      run({
        runId,
        startedAt,
        ...(target === undefined ? {} : { target: { baseUrl: target } }),
      }),
      [],
    );
  }

  it('returns the newest first, since the pair a user wants is the last two', () => {
    const store = open();
    save(store, 'RUN-a', '2026-08-18T00:00:00Z');
    save(store, 'RUN-b', '2026-08-18T02:00:00Z');
    save(store, 'RUN-c', '2026-08-18T01:00:00Z');

    expect(store.listRuns().map((one) => one.runId)).toStrictEqual(['RUN-b', 'RUN-c', 'RUN-a']);
  });

  it('honours a limit, and defaults to one', () => {
    const store = open();
    for (let index = 0; index < 3; index += 1) {
      save(store, `RUN-${index}`, `2026-08-18T0${index}:00:00Z`);
    }

    expect(store.listRuns({ limit: 2 })).toHaveLength(2);
    expect(store.listRuns()).toHaveLength(3);
    expect(DEFAULT_LIST_LIMIT).toBeGreaterThan(0);
  });

  it('filters by target, so two applications in one directory do not mix', () => {
    const store = open();
    save(store, 'RUN-a', '2026-08-18T00:00:00Z', 'http://one:3000');
    save(store, 'RUN-b', '2026-08-18T01:00:00Z', 'http://two:3000');

    expect(store.listRuns({ target: 'http://one:3000' }).map((one) => one.runId)).toStrictEqual([
      'RUN-a',
    ]);
  });

  it('reports the summary the stored run actually carries', () => {
    // Read out of the run rather than kept in its own columns. Two copies of one number
    // is how a listing starts disagreeing with the run it describes.
    const store = open();
    store.saveRun(
      run({
        summary: {
          requirements: { total: 9, verified: 4, failed: 3, unverified: 2 },
          checks: { total: 20, pass: 10, fail: 6, inconclusive: 4 },
          coverage: 0.75,
          findingsBySeverity: { high: 2, medium: 4, low: 0, info: 0 },
          modelAssistedCheckCount: 1,
        },
      }),
      [],
    );

    const [only] = store.listRuns();
    expect(only?.summary.requirements.failed).toBe(3);
    expect(only?.summary.coverage).toBe(0.75);
    expect(only?.specHash).toBe('sha256:abc');
  });

  it('returns nothing from an empty store rather than failing', () => {
    expect(open().listRuns()).toStrictEqual([]);
  });
});

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  EvidenceSchema,
  RunResultSchema,
  type Evidence,
  type RunResult,
  type Summary,
} from '../contracts/index.ts';
import { pruneStore, resolvePrunePolicy, type PrunePolicy, type PruneReport } from './prune.ts';
import { DEFAULT_EVIDENCE_DIR } from '../evidence/capture.ts';
import { isBodyAddress, resolveBodyPath } from '../evidence/address.ts';
import { openDatabase, type StoreDatabase } from './schema.ts';

/**
 * The run store: persistence, and the reads `diff` and `list` need.
 *
 * **Evidence bodies are not written here.** M2's writer already put them under
 * `.specgate/evidence/`, redacted at capture time, before this ever sees a record. Rule R8
 * says redaction happens on capture, so a store that re-serialized a body it never read
 * would be inventing content and could only get it wrong. What `saveRun` does is record
 * the reference and check whether the file is actually there.
 *
 * **A run is saved whole or not at all.** The row and every evidence row go in one
 * transaction, because a run whose evidence half-landed would look complete to `getRun`
 * and be missing the thing a finding cites.
 *
 * **A duplicate run id is refused, never replaced.** This store exists so two runs can be
 * compared, and silently overwriting one of them is the single thing it must not do.
 *
 * **Reads validate.** Rule R2: a row coming off disk is a boundary, and a database
 * written by a build with a different idea of RunResult should fail loudly here rather
 * than produce a delta from a shape nobody checked.
 *
 * **Retention runs on write, and reports.** Every `saveRun` prunes to the configured
 * window and hands the report back with the save report, so nothing has to remember to
 * ask. See `prune.ts` for what the window means and why a body file can outlive the run
 * that recorded it.
 */

export interface SaveReport {
  readonly runId: string;
  readonly evidenceRecorded: number;
  /**
   * Evidence whose body file is not on disk.
   *
   * Reported rather than thrown on. A run assembled without an evidence writer is
   * legitimate, and so is one whose bodies were pruned by an earlier run. What is not
   * legitimate is the store implying a body exists when it does not.
   */
  readonly bodiesMissing: readonly string[];
  /**
   * What retention removed as part of this write.
   *
   * Carried here rather than left for a caller to ask about, because the module's Do Not
   * says pruning is reported, and a report nobody requests is a report nobody reads.
   */
  readonly pruned: PruneReport;
}

export interface RunSummary {
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly toolVersion: string;
  readonly specHash: string;
  readonly target?: string;
  readonly summary: Summary;
}

export interface ListOptions {
  readonly limit?: number;
  readonly target?: string;
}

export interface Store {
  saveRun(result: RunResult, evidence: readonly Evidence[]): SaveReport;
  getRun(runId: string): RunResult | null;
  listRuns(opts?: ListOptions): RunSummary[];
  /** Applies retention now. Defaults to the window this store was opened with. */
  pruneEvidence(policy?: PrunePolicy): PruneReport;
  /** The state directory this store lives in, for whoever resolves an evidence path. */
  readonly stateDir: string;
  close(): void;
}

export interface StoreOptions {
  /**
   * The window every write prunes to. Defaults to twenty runs and five runs of evidence.
   *
   * Configurable because a corpus run and a laptop want different windows, and because a
   * test proving the rule should not have to write twenty one runs to reach it.
   */
  readonly retention?: PrunePolicy;
}

/** How many runs `listRuns` returns when the caller does not say. */
export const DEFAULT_LIST_LIMIT = 20;

interface RunRow {
  readonly run_id: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly tool_version: string;
  readonly spec_hash: string;
  readonly spec_version: string;
  readonly target: string | null;
  readonly result_json: string;
}

function parseRun(row: Pick<RunRow, 'run_id' | 'result_json'>): RunResult {
  let document: unknown;
  try {
    document = JSON.parse(row.result_json);
  } catch (cause) {
    throw new Error(`the stored run ${row.run_id} is not valid JSON`, { cause });
  }

  const parsed = RunResultSchema.safeParse(document);
  if (!parsed.success) {
    throw new Error(
      `the stored run ${row.run_id} does not match the current RunResult contract: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    );
  }

  return parsed.data;
}

/** `.specgate/evidence/EV-1.json` is relative to the project, not to the state directory. */
function bodyExists(projectDir: string, bodyRef: string | undefined): boolean {
  // A reference that is not a content address was written before P1.6 and names a path this
  // build no longer produces. Reporting it missing is the honest answer and is already a
  // case `saveRun` surfaces, rather than a resolution that cannot succeed.
  if (bodyRef === undefined || !isBodyAddress(bodyRef)) return false;
  return existsSync(
    resolveBodyPath(bodyRef, { cwd: projectDir, evidenceDir: DEFAULT_EVIDENCE_DIR }),
  );
}

export function openStore(dir: string, options: StoreOptions = {}): Store {
  const projectDir = resolve(dir);
  // Resolved at open time so a policy that would empty the store fails where it was
  // configured, rather than on the first write that acts on it.
  const retention = resolvePrunePolicy(options.retention);
  const { db, stateDir } = openDatabase(projectDir);

  const insertRun = db.prepare(
    `INSERT INTO runs (run_id, started_at, finished_at, tool_version, spec_hash, spec_version, target, result_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertEvidence = db.prepare(
    `INSERT INTO evidence (evidence_id, run_id, kind, captured_at, actor_id, body_path, record_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectRun = db.prepare('SELECT run_id, result_json FROM runs WHERE run_id = ?');
  const runExists = db.prepare('SELECT 1 FROM runs WHERE run_id = ?');

  return {
    stateDir,

    saveRun(result, evidence) {
      // Validated on the way in as well as on the way out. It is cheap, and a malformed
      // run caught here names the bug rather than surfacing as a broken delta later.
      const validated = RunResultSchema.safeParse(result);
      if (!validated.success) {
        throw new Error(
          `refusing to save a run that does not match the RunResult contract: ${validated.error.issues[0]?.message ?? 'unknown'}`,
        );
      }

      if (runExists.get(result.runId) !== undefined) {
        throw new Error(
          `a run with id ${result.runId} is already stored. Run ids are derived from the clock, so two runs close together can collide; nothing is overwritten.`,
        );
      }

      const records = evidence.map((one) => {
        const parsed = EvidenceSchema.safeParse(one);
        if (!parsed.success) {
          throw new Error(
            `refusing to save evidence ${one.id} that does not match the Evidence contract: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
          );
        }
        return parsed.data;
      });

      const bodiesMissing = records
        .filter((one) => !bodyExists(projectDir, one.response?.bodyRef))
        .map((one) => one.id);

      // One transaction. A run whose evidence half-landed would look complete to getRun
      // and be missing the thing a finding cites.
      const write = db.transaction(() => {
        insertRun.run(
          result.runId,
          result.startedAt,
          result.finishedAt,
          result.toolVersion,
          result.spec.hash,
          result.spec.specVersion,
          result.target.baseUrl ?? null,
          JSON.stringify(result),
        );

        for (const one of records) {
          insertEvidence.run(
            one.id,
            result.runId,
            one.kind,
            one.capturedAt,
            one.actorId ?? null,
            one.response?.bodyRef ?? null,
            JSON.stringify(one),
          );
        }
      });

      write();

      // Prune on write, as the module says. The run just saved is subject to the window
      // like any other: a run older than everything already stored is pruned immediately,
      // and the report names it rather than letting it vanish.
      const pruned = pruneStore(db, projectDir, retention);

      return { runId: result.runId, evidenceRecorded: records.length, bodiesMissing, pruned };
    },

    getRun(runId) {
      const row = selectRun.get(runId) as Pick<RunRow, 'run_id' | 'result_json'> | undefined;
      return row === undefined ? null : parseRun(row);
    },

    listRuns(opts = {}) {
      const limit = opts.limit ?? DEFAULT_LIST_LIMIT;

      // Newest first, because the pair a user almost always wants is the last two.
      const rows = (
        opts.target === undefined
          ? db
              .prepare(
                'SELECT run_id, started_at, finished_at, tool_version, spec_hash, spec_version, target, result_json FROM runs ORDER BY started_at DESC, run_id DESC LIMIT ?',
              )
              .all(limit)
          : db
              .prepare(
                'SELECT run_id, started_at, finished_at, tool_version, spec_hash, spec_version, target, result_json FROM runs WHERE target = ? ORDER BY started_at DESC, run_id DESC LIMIT ?',
              )
              .all(opts.target, limit)
      ) as RunRow[];

      // The summary is read out of the stored run rather than kept in its own columns.
      // Two copies of one number is how a listing starts disagreeing with the run it
      // claims to describe, and the module's Do Not rules out an analytics store anyway.
      return rows.map((row) => {
        const run = parseRun(row);
        return {
          runId: row.run_id,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          toolVersion: row.tool_version,
          specHash: row.spec_hash,
          ...(row.target === null ? {} : { target: row.target }),
          summary: run.summary,
        };
      });
    },

    pruneEvidence(policy = retention) {
      return pruneStore(db, projectDir, policy);
    },

    close() {
      db.close();
    },
  };
}

export type { StoreDatabase };

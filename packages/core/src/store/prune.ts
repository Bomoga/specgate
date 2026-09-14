import { existsSync, unlinkSync } from 'node:fs';

import { DEFAULT_EVIDENCE_DIR } from '../evidence/capture.ts';
import { isBodyAddress, resolveBodyPath } from '../evidence/address.ts';
import type { StoreDatabase } from './schema.ts';

/**
 * Retention. The store keeps the last twenty runs and the evidence for the last five,
 * and it says what it removed.
 *
 * **Pruning is reported, never silent.** The module's Do Not is explicit about it, and
 * the reason is the same one that makes the store refuse a duplicate run id: this is run
 * history, and history that disappears without a sentence is indistinguishable from
 * history that was never there. A caller gets the run ids, the evidence records, and the
 * body files, and can print any of them.
 *
 * **The database cascade is only half the job.** Deleting a run takes its evidence rows
 * with it, because `evidence.run_id` references `runs` with `ON DELETE CASCADE`. The body
 * files under `.specgate/evidence/` are not rows and no cascade reaches them, so unlinking
 * them is this file's own work.
 *
 * **A body file is unlinked only when no surviving evidence row still names it.** That is
 * not defensive coding: evidence ids come from a per-run counter, so every run writes
 * `EV-000001.json`, and two runs really do point at one file today. Deleting the older
 * run's body would delete the newer run's evidence.
 */

export interface PrunePolicy {
  /** How many runs to keep, newest first. At least one. */
  readonly keepRuns?: number;
  /** How many of those runs keep their evidence, newest first. May be zero. */
  readonly keepEvidence?: number;
}

/** The module's stated default: twenty runs, and the evidence for five of them. */
export const DEFAULT_PRUNE_POLICY = { keepRuns: 20, keepEvidence: 5 } as const;

export interface ResolvedPrunePolicy {
  readonly keepRuns: number;
  readonly keepEvidence: number;
}

export interface PrunedEvidence {
  readonly runId: string;
  readonly evidenceId: string;
  /** Absent when the record never referenced a body, which is every non-http kind. */
  readonly bodyPath?: string;
}

export interface PruneReport {
  /** What the run was pruned by, so a report can state the window rather than imply it. */
  readonly policy: ResolvedPrunePolicy;
  /** Run ids removed entirely, newest first, in the order `listRuns` would have shown them. */
  readonly runsRemoved: readonly string[];
  readonly runsRetained: number;
  /** Evidence rows removed, both from removed runs and from runs that outlived their evidence. */
  readonly evidenceRemoved: readonly PrunedEvidence[];
  /** Body files unlinked, as the path the record carried. */
  readonly bodiesDeleted: readonly string[];
  /** Recorded body paths that were not on disk. Reported, since an absence is not a deletion. */
  readonly bodiesMissing: readonly string[];
  /** Body paths left alone because a surviving evidence row still names them. */
  readonly bodiesStillReferenced: readonly string[];
}

function whole(name: string, value: number, minimum: number): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(
      `the retention policy's ${name} has to be a whole number of at least ${minimum}, and it is ${value}. Keeping fewer would delete the run that was just written.`,
    );
  }
  return value;
}

/**
 * Fills in the defaults and refuses a policy that would empty the store.
 *
 * `keepRuns` of zero is refused rather than clamped. Pruning happens on write, so a zero
 * window deletes the run the caller just handed over, and a store that discards its input
 * is worse than one that will not open.
 */
export function resolvePrunePolicy(policy: PrunePolicy = {}): ResolvedPrunePolicy {
  return {
    keepRuns: whole('keepRuns', policy.keepRuns ?? DEFAULT_PRUNE_POLICY.keepRuns, 1),
    keepEvidence: whole(
      'keepEvidence',
      policy.keepEvidence ?? DEFAULT_PRUNE_POLICY.keepEvidence,
      0,
    ),
  };
}

interface EvidenceRow {
  readonly run_id: string;
  readonly evidence_id: string;
  readonly body_path: string | null;
}

/**
 * Where a content address lands on disk, per D51.
 *
 * A reference that is not an address belongs to a run stored before P1.6 and cannot be
 * resolved: the old form was a path into a directory layout this build no longer writes.
 * Returning undefined makes it count as missing, which is already a case this function's
 * caller handles, rather than throwing and taking retention down with it.
 */
function bodyFileFor(projectDir: string, bodyRef: string): string | undefined {
  if (!isBodyAddress(bodyRef)) return undefined;
  return resolveBodyPath(bodyRef, { cwd: projectDir, evidenceDir: DEFAULT_EVIDENCE_DIR });
}

/**
 * Applies `policy` and reports what it removed.
 *
 * The order is deliberate. Rows go first, in one transaction, so the database is never
 * left claiming evidence it has half deleted. Only then is the surviving reference set
 * read, because what matters is whether anything still points at a file after the
 * deletions, not before. Files are unlinked last, outside the transaction, since a
 * filesystem does not roll back and pretending otherwise would be a lie in the report.
 */
export function pruneStore(
  db: StoreDatabase,
  projectDir: string,
  policy: PrunePolicy = {},
): PruneReport {
  const resolved = resolvePrunePolicy(policy);

  // Newest first, the same order listRuns shows, so retention keeps what a user saw at
  // the top of the list rather than a second opinion about which runs are recent.
  const ordered = (
    db.prepare('SELECT run_id FROM runs ORDER BY started_at DESC, run_id DESC').all() as {
      run_id: string;
    }[]
  ).map((row) => row.run_id);

  const runsRemoved = ordered.slice(resolved.keepRuns);

  // Evidence survives only on the newest few runs. A run removed outright is past both
  // windows, so one set covers it: everything outside the evidence window loses its rows,
  // and the runs beyond keepRuns lose themselves as well.
  const evidenceKept = new Set(
    ordered.slice(0, Math.min(resolved.keepEvidence, resolved.keepRuns)),
  );

  const evidenceRows = db
    .prepare(
      'SELECT run_id, evidence_id, body_path FROM evidence ORDER BY run_id ASC, evidence_id ASC',
    )
    .all() as EvidenceRow[];

  const doomed = evidenceRows.filter((row) => !evidenceKept.has(row.run_id));

  const deleteEvidenceForRun = db.prepare('DELETE FROM evidence WHERE run_id = ?');
  const deleteRun = db.prepare('DELETE FROM runs WHERE run_id = ?');

  const losingEvidence = ordered.filter((runId) => !evidenceKept.has(runId));

  const write = db.transaction(() => {
    for (const runId of losingEvidence) deleteEvidenceForRun.run(runId);
    for (const runId of runsRemoved) deleteRun.run(runId);
  });

  write();

  // Read after the deletions. A path is still referenced only if something that survived
  // names it, and asking before would have counted the rows just removed.
  const surviving = new Set(
    (
      db.prepare('SELECT DISTINCT body_path FROM evidence WHERE body_path IS NOT NULL').all() as {
        body_path: string;
      }[]
    ).map((row) => row.body_path),
  );

  const candidates = [
    ...new Set(
      doomed
        .map((row) => row.body_path)
        .filter((path): path is string => path !== null && path !== ''),
    ),
  ].sort();

  const bodiesDeleted: string[] = [];
  const bodiesMissing: string[] = [];
  const bodiesStillReferenced: string[] = [];

  for (const path of candidates) {
    if (surviving.has(path)) {
      bodiesStillReferenced.push(path);
      continue;
    }

    const file = bodyFileFor(projectDir, path);
    if (file === undefined || !existsSync(file)) {
      bodiesMissing.push(path);
      continue;
    }

    unlinkSync(file);
    bodiesDeleted.push(path);
  }

  return {
    policy: resolved,
    runsRemoved,
    runsRetained: ordered.length - runsRemoved.length,
    evidenceRemoved: doomed.map((row) => ({
      runId: row.run_id,
      evidenceId: row.evidence_id,
      ...(row.body_path === null ? {} : { bodyPath: row.body_path }),
    })),
    bodiesDeleted,
    bodiesMissing,
    bodiesStillReferenced,
  };
}

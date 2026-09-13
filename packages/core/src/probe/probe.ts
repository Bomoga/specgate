import { resolve } from 'node:path';

import type { Observation, ObservationNote } from '../contracts/index.ts';
import { crawl, type CrawlSession } from './crawl.ts';
import { buildObservation, mergeScans, type MergeInput } from './merge.ts';
import { createAdapterRegistry } from './registry.ts';
import { createExpressAdapter } from './source/express.ts';
import { createNextAdapter } from './source/next.ts';
import { createPrismaAdapter } from './source/prisma.ts';
import type { ProbeOptions, SourceAdapter, SourceScan } from './types.ts';

/**
 * The probe: read the source if there is any, crawl the target if it is running, and
 * reconcile the two into one Observation.
 *
 * Source first, black box fallback, hybrid when both are available. Every part of it is
 * read-only, and none of it is given the spec. Matching an Observation against what was
 * asked for happens in the diff, because a probe that knew what it was looking for
 * would find it.
 *
 * A missing half is a note, not a failure. A target with no source root still produces
 * an Observation from the crawl, and a target that is not running still produces one
 * from the source, each saying plainly which half it is missing.
 */

/**
 * The adapters Q1 lists. More than one recognizing a repository is normal rather than a
 * conflict: a Next.js application with a Prisma schema is two adapters describing
 * different things, routes and models.
 */
export function defaultAdapters(): SourceAdapter[] {
  return [createNextAdapter(), createExpressAdapter(), createPrismaAdapter()];
}

/**
 * What the probe needs from the target context, which is a base URL, a source root, and
 * an identity that can issue a request. An M2 `TargetContext` satisfies this as it
 * stands. Naming the narrower shape keeps the probe away from credentials, the evidence
 * writer, and the redaction rules, none of which it has any business reaching.
 */
export interface ProbeContext {
  readonly config: {
    readonly target: {
      readonly baseUrl?: string;
      readonly sourceRoot?: string;
    };
  };
  readonly sessions: ReadonlyMap<string, CrawlSession>;
}

export async function probe(ctx: ProbeContext, opts: ProbeOptions): Promise<Observation> {
  const sourceRoot = opts.sourceRoot ?? ctx.config.target.sourceRoot;
  const baseUrl = opts.baseUrl ?? ctx.config.target.baseUrl;
  const cwd = opts.cwd ?? process.cwd();

  const notes: ObservationNote[] = [];
  let source: SourceScan | undefined;
  let blackbox: SourceScan | undefined;

  if (sourceRoot !== undefined) {
    const registry = createAdapterRegistry(opts.adapters ?? defaultAdapters());
    const result = await registry.scan(resolve(cwd, sourceRoot));

    // A source root nothing recognized is not a source reading. Counting it as one
    // would report `hybrid` for a run whose source half contributed nothing, and then
    // treat every crawled endpoint as a disagreement with a side that never spoke.
    if (result.applied.length > 0) {
      source = result.scan;
      opts.reporter?.info(`source read by ${result.applied.join(', ')}`);
    } else {
      notes.push(...result.scan.notes);
      // A configured source root that nothing recognized degrades the run to black box,
      // and the Observation records that. Saying it here too means a reader finds out
      // while the probe is running rather than from a note at the end.
      opts.reporter?.warn(
        `No source adapter recognized ${sourceRoot}, so this run is black box and no finding can cite a file.`,
      );
    }
  } else {
    notes.push({
      level: 'info',
      message:
        'No source root is configured, so the Observation is black box only and every endpoint in it was inferred from traffic.',
      refs: [],
    });
  }

  // The first configured actor, per the module. A crawl compares nothing, so one
  // identity is enough, and using more would multiply the traffic for no new fact.
  const session = [...ctx.sessions.values()][0];

  if (baseUrl !== undefined && session !== undefined) {
    blackbox = await crawl(session, {
      baseUrl,
      ...(opts.startPaths === undefined ? {} : { startPaths: opts.startPaths }),
      ...(opts.maxPages === undefined ? {} : { maxPages: opts.maxPages }),
      ...(opts.maxDepth === undefined ? {} : { maxDepth: opts.maxDepth }),
    });
  } else if (baseUrl === undefined) {
    notes.push({
      level: 'info',
      message:
        'No base URL is configured, so nothing was requested and the Observation describes the source alone.',
      refs: [],
    });
  } else {
    notes.push({
      level: 'warn',
      message:
        'No actor could be resolved, so the target was not crawled and the Observation describes the source alone.',
      refs: [],
    });
  }

  const input: MergeInput = {
    ...(source === undefined ? {} : { source }),
    ...(blackbox === undefined ? {} : { blackbox }),
  };

  const merged = mergeScans(input);

  return buildObservation(
    { ...merged, notes: [...notes, ...merged.notes] },
    {
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(sourceRoot === undefined ? {} : { sourceRoot }),
    },
    opts.deps.now(),
  );
}

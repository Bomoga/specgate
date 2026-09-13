import type {
  Confidence,
  ObservationNote,
  ObservedEndpoint,
  ObservedEntity,
  ProbeMode,
} from '../contracts/index.ts';
import type { Reporter } from '../report/reporter.ts';
import type { Deps } from '../target/deps.ts';

/**
 * Probe interfaces and the adapter contract.
 *
 * The probe records what exists. It is deliberately not given the spec: matching
 * happens afterward, in the diff. A probe that knew what it was looking for would find
 * it, and an Observation biased toward the spec cannot support a finding that says the
 * spec and the application disagree.
 *
 * Everything here is read-only. An adapter reads files, a crawler issues GET and HEAD,
 * and nothing in this directory writes to a target or submits a form.
 */

export interface SourceScan {
  readonly endpoints: readonly ObservedEndpoint[];
  readonly entities: readonly ObservedEntity[];
  /** Files that could not be parsed, and anything else a reader should know. */
  readonly notes: readonly ObservationNote[];
}

/**
 * A source adapter for one framework.
 *
 * `detect` is cheap and answers whether the adapter applies at all; `scan` does the
 * work. Splitting them keeps a run over a repository with three frameworks from
 * parsing all of everything, and lets the capability report say which adapters
 * recognized the target before anything is read in full.
 */
export interface SourceAdapter {
  /** Stable name, reported in notes so a reader knows which adapter said what. */
  readonly name: string;
  detect(root: string): Promise<boolean>;
  scan(root: string): Promise<SourceScan>;
}

export interface ProbeOptions {
  /**
   * Where progress goes. Absent discards it, so no code path has to test whether it was
   * given one. Threading it here is what lets a run stream progress to something that is
   * not a terminal, which is why a port declared for tidiness turns out to be load bearing.
   */
  readonly reporter?: Reporter;

  /** Injected clock, per rule R6. An Observation is timestamped and must be reproducible. */
  readonly deps: Deps;
  /** Absent means no source is available and the probe is black box only. */
  readonly sourceRoot?: string;
  readonly baseUrl?: string;
  /** Directory a relative `sourceRoot` is resolved against. Defaults to the process cwd. */
  readonly cwd?: string;
  /** Where the crawl starts. Defaults to the site root. */
  readonly startPaths?: readonly string[];
  /** Hard ceiling on crawled pages. A probe that runs forever is not read-only in practice. */
  readonly maxPages?: number;
  readonly maxDepth?: number;
  /** Adapters to consider. Defaults to everything registered. */
  readonly adapters?: readonly SourceAdapter[];
}

export const DEFAULT_MAX_PAGES = 50;
export const DEFAULT_MAX_DEPTH = 3;

/**
 * What a probe run produced, before it is assembled into an Observation. Kept separate
 * so the merge in M4.7 has both sides and their origins rather than one flattened list
 * in which a disagreement has already been silently resolved.
 */
export interface ProbeFindings {
  readonly mode: ProbeMode;
  readonly source?: SourceScan;
  readonly blackbox?: SourceScan;
  readonly notes: readonly ObservationNote[];
  /** Adapters that recognized the source root, in the order they were tried. */
  readonly adaptersApplied: readonly string[];
}

/**
 * Confidence levels the merge assigns.
 *
 * Source is authoritative about what routes exist: an adapter read the declaration, it
 * did not deduce it. Black box alone is inference from traffic, which can miss a route
 * nothing linked to and can mistake one route for two. Both agreeing is the strongest
 * statement available, and disagreement is recorded as `medium` with a note rather than
 * resolved silently, because which side is wrong is exactly what a reader needs to see.
 */
export const CONFIDENCE_SOURCE_ONLY: Confidence = 'high';
export const CONFIDENCE_BLACKBOX_ONLY: Confidence = 'low';
export const CONFIDENCE_BOTH_AGREE: Confidence = 'high';
export const CONFIDENCE_DISAGREEMENT: Confidence = 'medium';

export function emptyScan(): SourceScan {
  return { endpoints: [], entities: [], notes: [] };
}

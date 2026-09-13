/**
 * The run, as something other than the CLI can execute.
 *
 * Types land here before their consumer, per the commit cadence rule, so the dependent
 * commit is reviewable on its own and a bisect lands somewhere meaningful.
 */
export { RunFatalError, isRunFatal } from './types.ts';
export type { ExecuteRun, RunInput, RunPorts } from './types.ts';

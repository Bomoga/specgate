import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Two import boundaries are enforced here, and they overlap in `packages/core`, so
 * they are composed rather than layered. `no-restricted-imports` is a single rule
 * key: a later config block that sets it replaces the earlier setting outright.
 * Every block below therefore restates every group that applies to its scope.
 */

export const LLM_BOUNDARY_RULE = '@typescript-eslint/no-restricted-imports';

/** Invariant I1, hard rule R1: only this directory may import a model client. */
export const LLM_BOUNDARY_DIR = 'packages/core/src/llm/';

export const LLM_CLIENT_PATTERNS = [
  '@anthropic-ai/*',
  'openai',
  'openai/*',
  '@google/genai',
  '@google/generative-ai',
  '@mistralai/*',
  '@aws-sdk/client-bedrock-runtime',
  'cohere-ai',
  'replicate',
  'ollama',
  'ai',
  '@ai-sdk/*',
  'langchain',
  'langchain/*',
  '@langchain/*',
];

export const LLM_BOUNDARY_MESSAGE =
  'Invariant I1: model clients may only be imported from ' +
  LLM_BOUNDARY_DIR +
  '. Everywhere else, a verdict must be produced by deterministic assertion.';

/** the architecture: core depends on nothing here, cli depends on core, action depends on cli. */
export const CORE_FORBIDDEN_PATTERNS = [
  '@specgate/cli',
  '@specgate/cli/*',
  '@specgate/action',
  '@specgate/action/*',
  '@specgate/server',
  '@specgate/server/*',
  '@specgate/web',
  '@specgate/web/*',
  '@specgate/client',
  '@specgate/client/*',
  '@specgate/runner',
  '@specgate/runner/*',
];
export const CLI_FORBIDDEN_PATTERNS = ['@specgate/action', '@specgate/action/*'];

/**
 * Hard rule R14, and the one boundary rule most likely to be waved through in review.
 *
 * The control plane must never be able to run a check, because a code path that can is a
 * code path that will eventually be asked to. Everything the server needs to understand
 * about a run arrives as data validated against `contracts`. It costs a little
 * duplication, since the server re-derives summary counts `assembleRun` already computed,
 * and it buys invariant I8 being structural rather than cultural.
 */
export const SERVER_FORBIDDEN_PATTERNS = [
  '@specgate/core',
  '@specgate/core/*',
  '@specgate/cli',
  '@specgate/cli/*',
  '@specgate/action',
  '@specgate/action/*',
];

export const SERVER_DIRECTION_MESSAGE =
  'Rule R14: server imports nothing from core. The control plane must not be able to execute a check. Everything it needs about a run arrives as data validated against contracts.';

export const CORE_DIRECTION_MESSAGE =
  'core imports nothing from cli or action. If core needs to tell the user something, it returns data.';

/**
 * M3 Definition of Done: no check imports anything from `packages/core/src/llm/`.
 * The model client patterns already stop a check reaching a model directly. This stops
 * the indirect route, a check importing a helper that wraps one, which is how a model
 * would actually end up in a verdict path.
 */
export const CHECKS_FORBIDDEN_PATTERNS = ['**/llm', '**/llm/**'];

export const CHECKS_BOUNDARY_MESSAGE =
  'Invariant I1: a check may not import from llm/. Verdicts are produced by deterministic assertion, and a check that reaches the model layer at all has left that guarantee behind.';

export const CLI_DIRECTION_MESSAGE =
  'cli does not import action. action is the outer shell and depends on cli, not the reverse.';

const llmGroup = { group: LLM_CLIENT_PATTERNS, message: LLM_BOUNDARY_MESSAGE };
const coreDirectionGroup = { group: CORE_FORBIDDEN_PATTERNS, message: CORE_DIRECTION_MESSAGE };
const cliDirectionGroup = { group: CLI_FORBIDDEN_PATTERNS, message: CLI_DIRECTION_MESSAGE };
const checksBoundaryGroup = { group: CHECKS_FORBIDDEN_PATTERNS, message: CHECKS_BOUNDARY_MESSAGE };
const serverDirectionGroup = {
  group: SERVER_FORBIDDEN_PATTERNS,
  message: SERVER_DIRECTION_MESSAGE,
};

/** @param {{ group: string[], message: string }[]} groups */
function restrict(groups) {
  return ['error', { patterns: groups.map((entry) => ({ ...entry, allowTypeImports: false })) }];
}

export default tseslint.config(
  {
    /**
     * Generated output nobody reviews.
     *
     * `.next/` and `next-env.d.ts` are both written by Next on boot, so the conformance
     * test recreates them every time it runs. They are gitignored, and eslint does not
     * read `.gitignore`, so they have to be named here as well or a passing test leaves a
     * failing lint behind it.
     */
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.next/**',
      '**/next-env.d.ts',
      '.specgate/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      [LLM_BOUNDARY_RULE]: restrict([llmGroup]),
    },
  },
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      [LLM_BOUNDARY_RULE]: restrict([llmGroup, coreDirectionGroup]),
    },
  },
  {
    // Checks carry the model boundary, the dependency direction, and no llm/ by path.
    files: ['packages/core/src/checks/**/*.ts'],
    rules: {
      [LLM_BOUNDARY_RULE]: restrict([llmGroup, coreDirectionGroup, checksBoundaryGroup]),
    },
  },
  {
    // The one place a model client is allowed. The dependency direction still holds.
    files: [`${LLM_BOUNDARY_DIR}**/*.ts`],
    rules: {
      [LLM_BOUNDARY_RULE]: restrict([coreDirectionGroup]),
    },
  },
  {
    files: ['packages/cli/**/*.ts'],
    rules: {
      [LLM_BOUNDARY_RULE]: restrict([llmGroup, cliDirectionGroup]),
    },
  },
  {
    // Rule R14. The model boundary applies here as everywhere, and the control plane
    // additionally may not reach the engine at all.
    files: ['packages/server/**/*.ts'],
    rules: {
      [LLM_BOUNDARY_RULE]: restrict([llmGroup, serverDirectionGroup]),
    },
  },
);

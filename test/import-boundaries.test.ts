import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import {
  CHECKS_FORBIDDEN_PATTERNS,
  CLI_FORBIDDEN_PATTERNS,
  CORE_FORBIDDEN_PATTERNS,
  SERVER_FORBIDDEN_PATTERNS,
  LLM_BOUNDARY_DIR,
  LLM_BOUNDARY_RULE,
  LLM_CLIENT_PATTERNS,
} from '../eslint.config.js';

/**
 * Hard rule R1 requires a test asserting the model boundary rule is configured, and
 * the architecture requires the package dependency direction to be lint enforced.
 * Both are asserted against the config ESLint actually resolves for a path, not
 * against the shape of the config file, so a reordering that silently drops a rule
 * fails here rather than passing review.
 */

const eslint = new ESLint();

interface RestrictedPattern {
  group: string[];
}

function isRestrictedPattern(value: unknown): value is RestrictedPattern {
  if (typeof value !== 'object' || value === null) return false;
  const group = (value as { group?: unknown }).group;
  return Array.isArray(group) && group.every((item) => typeof item === 'string');
}

/** Every module specifier the resolved config forbids for this file path. */
async function forbiddenSpecifiersFor(filePath: string): Promise<string[]> {
  const resolved: unknown = await eslint.calculateConfigForFile(filePath);
  if (typeof resolved !== 'object' || resolved === null) return [];

  const rules = (resolved as { rules?: Record<string, unknown> }).rules ?? {};
  const entry = rules[LLM_BOUNDARY_RULE];
  if (!Array.isArray(entry)) return [];

  const options = entry[1];
  if (typeof options !== 'object' || options === null) return [];

  const patterns = (options as { patterns?: unknown }).patterns;
  if (!Array.isArray(patterns)) return [];

  return patterns.filter(isRestrictedPattern).flatMap((pattern) => pattern.group);
}

describe('the model boundary', () => {
  it('forbids model clients in core outside the llm directory', async () => {
    const forbidden = await forbiddenSpecifiersFor('packages/core/src/checks/access/verdict.ts');
    for (const pattern of LLM_CLIENT_PATTERNS) {
      expect(forbidden).toContain(pattern);
    }
  });

  it('forbids model clients in cli and action', async () => {
    const cli = await forbiddenSpecifiersFor('packages/cli/src/index.ts');
    const action = await forbiddenSpecifiersFor('packages/action/src/index.ts');
    expect(cli).toContain('openai');
    expect(action).toContain('openai');
  });

  it('permits model clients only inside the llm directory', async () => {
    const forbidden = await forbiddenSpecifiersFor(`${LLM_BOUNDARY_DIR}extract.ts`);
    for (const pattern of LLM_CLIENT_PATTERNS) {
      expect(forbidden).not.toContain(pattern);
    }
  });
});

describe('the check boundary', () => {
  it('stops a check importing from llm/ by path, not only by client name', async () => {
    const forbidden = await forbiddenSpecifiersFor('packages/core/src/checks/access/verdict.ts');
    for (const pattern of CHECKS_FORBIDDEN_PATTERNS) {
      expect(forbidden).toContain(pattern);
    }
  });

  it('keeps the model client restriction on checks as well', async () => {
    const forbidden = await forbiddenSpecifiersFor('packages/core/src/checks/registry.ts');
    expect(forbidden).toContain('openai');
    expect(forbidden).toContain('@anthropic-ai/*');
  });

  it('does not restrict llm/ by path outside checks, since core assembles both', async () => {
    const forbidden = await forbiddenSpecifiersFor('packages/core/src/index.ts');
    expect(forbidden).not.toContain('**/llm/**');
  });
});

describe('the package dependency direction', () => {
  it('stops core importing cli or action, including from the llm directory', async () => {
    const core = await forbiddenSpecifiersFor('packages/core/src/index.ts');
    const llm = await forbiddenSpecifiersFor(`${LLM_BOUNDARY_DIR}extract.ts`);
    for (const pattern of CORE_FORBIDDEN_PATTERNS) {
      expect(core).toContain(pattern);
      expect(llm).toContain(pattern);
    }
  });

  it('stops cli importing action', async () => {
    const cli = await forbiddenSpecifiersFor('packages/cli/src/index.ts');
    for (const pattern of CLI_FORBIDDEN_PATTERNS) {
      expect(cli).toContain(pattern);
    }
  });

  it('leaves cli free to import core', async () => {
    const cli = await forbiddenSpecifiersFor('packages/cli/src/index.ts');
    expect(cli).not.toContain('@specgate/core');
  });

  it('leaves action free to import cli', async () => {
    const action = await forbiddenSpecifiersFor('packages/action/src/index.ts');
    expect(action).not.toContain('@specgate/cli');
  });
});

/**
 * Rule R14, asserted the same way R1 is: against the config ESLint actually resolves for
 * a path, so a reordering that silently drops the rule fails here rather than in review.
 *
 * This is the boundary the architecture singles out as the one to defend. `packages/server`
 * does not exist yet, and the assertion does not need it to: `calculateConfigForFile`
 * answers for a path, and the rule has to be in place before the first file is written or
 * it will be added after the first import that violates it.
 */
describe('the plane boundary, rule R14', () => {
  it('stops server importing core, cli, or action', async () => {
    const server = await forbiddenSpecifiersFor('packages/server/src/index.ts');
    for (const pattern of SERVER_FORBIDDEN_PATTERNS) {
      expect(server).toContain(pattern);
    }
  });

  it('stops core importing server, web, client, or runner', async () => {
    // The existing rule extended. It is what keeps the engine embeddable and the CLI
    // usable with no control plane at all, per D30 and D34.
    const core = await forbiddenSpecifiersFor('packages/core/src/index.ts');
    for (const pattern of [
      '@specgate/server',
      '@specgate/web',
      '@specgate/client',
      '@specgate/runner',
    ]) {
      expect(core).toContain(pattern);
    }
  });

  it('leaves server free to import contracts, which is how a run reaches it', async () => {
    // Everything the control plane understands about a run arrives as data validated
    // against `contracts`. Forbidding that too would leave it no legitimate route.
    const server = await forbiddenSpecifiersFor('packages/server/src/index.ts');
    expect(server).not.toContain('@specgate/contracts');
  });

  it('keeps the model boundary on server as well', async () => {
    // The control plane has no verdict path, and the cheapest way to keep it that way is
    // for a model client to be unimportable there in the first place.
    const server = await forbiddenSpecifiersFor('packages/server/src/index.ts');
    expect(server).toContain('@anthropic-ai/*');
  });
});

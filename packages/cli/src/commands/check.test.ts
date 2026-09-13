import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { observationIdFrom, runIdFrom } from '@specgate/core';
import {
  fixedDeps,
  isConfigFailure,
  loadConfig,
  silentReporter,
  type TargetConfig,
} from '@specgate/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Stream } from '../reporter.ts';
import { BUILT_IN_DEFAULTS, type Settings } from '../settings.ts';
import { runCheck } from './check.ts';

/**
 * The paths through `check` that need no target.
 *
 * A run against a live application is an integration test and lives at M8.9, against
 * `fixtures/ledger`. What is worth pinning here is every way a run refuses to start, and
 * the exit code each one produces, because those are the codes CI reads and 1 is
 * reserved: the contract gives it to a run that completed and found something, so
 * nothing that failed to start may return it.
 *
 * The unreachable case points at a closed local port. That is a refused connection on
 * loopback, not network access, so rule R9 holds.
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'specgate-check-'));
  mkdirSync(join(dir, 'spec'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function capture(): { stream: Stream; text: () => string } {
  const chunks: string[] = [];
  return {
    stream: { write: (chunk: string) => void chunks.push(chunk) },
    text: () => chunks.join(''),
  };
}

const SPEC = `specVersion: '0.1'
name: 'Small app'
actors:
  - id: owner
    description: 'The owner'
entities:
  - name: Document
    fields:
      - name: id
        type: string
requirements:
  - id: REQ-001
    statement: 'An owner can read their own document'
    entities: [Document]
    accessRules:
      - id: AR-001-01
        actor: owner
        action: read
        resource: Document
        effect: allow
`;

/** A port nothing is listening on, so the connection is refused rather than answered. */
const CLOSED_PORT_URL = 'http://127.0.0.1:9';

function configWith(baseUrl?: string): TargetConfig {
  const body = [
    'target:',
    ...(baseUrl === undefined ? [] : [`  baseUrl: ${baseUrl}`]),
    '  disposable: false',
    'actors:',
    '  - id: owner',
    '    auth:',
    '      kind: none',
    '',
  ].join('\n');

  writeFileSync(join(dir, 'specgate.config.yaml'), body, 'utf8');
  const loaded = loadConfig('specgate.config.yaml', dir);
  if (isConfigFailure(loaded)) throw new Error(loaded.error.message);
  return loaded.config;
}

function settings(overrides: Partial<Record<keyof Settings, unknown>> = {}): Settings {
  return {
    format: { value: BUILT_IN_DEFAULTS.format, source: 'default' },
    out: { value: undefined, source: 'default' },
    failOn: { value: BUILT_IN_DEFAULTS.failOn, source: 'default' },
    failOnUnverified: { value: false, source: 'default' },
    concurrency: { value: 1, source: 'default' },
    ...overrides,
  } as Settings;
}

async function check(options: { config?: TargetConfig; paths?: readonly string[] } = {}) {
  const out = capture();
  const err = capture();
  const code = await runCheck({
    cwd: dir,
    env: {},
    paths: options.paths ?? [],
    config: options.config,
    configPath: 'specgate.config.yaml',
    settings: settings(),
    stdout: out.stream,
    stderr: err.stream,
    reporter: silentReporter,
    // Pinned so a failure here is never about the clock.
    deps: fixedDeps('2026-08-18T12:00:00.000Z'),
  });
  return { code, out: out.text(), err: err.text() };
}

describe('specgate check, before a run can start', () => {
  it('exits 2 with no configuration, naming the command that writes one', async () => {
    writeFileSync(join(dir, 'spec', 'app.spec.yaml'), SPEC, 'utf8');

    const { code, err, out } = await check();

    expect(code).toBe(2);
    expect(err).toContain('specgate init');
    expect(out).toBe('');
  });

  it('exits 2 when no spec matches, and points at validate for the detail', async () => {
    const { code, err } = await check({ config: configWith(CLOSED_PORT_URL) });

    expect(code).toBe(2);
    expect(err).toContain('no spec files matched');
    expect(err).toContain('specgate validate');
  });

  it('exits 2 when a spec will not load', async () => {
    writeFileSync(join(dir, 'spec', 'app.spec.yaml'), 'requirements: not-a-list\n', 'utf8');

    expect((await check({ config: configWith(CLOSED_PORT_URL) })).code).toBe(2);
  });

  it('exits 2 when the target has no baseUrl, since a check has nowhere to send requests', async () => {
    writeFileSync(join(dir, 'spec', 'app.spec.yaml'), SPEC, 'utf8');

    const { code, err } = await check({ config: configWith() });

    expect(code).toBe(2);
    expect(err).toContain('target.baseUrl');
  });

  it('exits 3 naming the url and the reason when the target cannot be reached', async () => {
    // Not 1. A run that never happened has not found anything, and reporting it as
    // findings is the failure that would make CI unreadable.
    writeFileSync(join(dir, 'spec', 'app.spec.yaml'), SPEC, 'utf8');

    const { code, err, out } = await check({ config: configWith(CLOSED_PORT_URL) });

    expect(code).toBe(3);
    expect(err).toContain(CLOSED_PORT_URL);
    expect(err).not.toBe('');
    expect(out).toBe('');
  });

  it('never returns 1 from a run that did not start', async () => {
    // 1 belongs to a completed run with findings. Sweeping the refusal paths is what
    // stops one of them drifting onto it later.
    writeFileSync(join(dir, 'spec', 'app.spec.yaml'), SPEC, 'utf8');

    const codes = [
      (await check()).code,
      (await check({ config: configWith() })).code,
      (await check({ config: configWith(CLOSED_PORT_URL) })).code,
    ];

    expect(codes).toStrictEqual([2, 2, 3]);
  });

  it('writes nothing to stdout when the run refuses to start', async () => {
    // Stdout carries the report. A refusal has no report, so a pipeline reading stdout
    // gets an empty document rather than a half of one.
    writeFileSync(join(dir, 'spec', 'app.spec.yaml'), SPEC, 'utf8');

    expect((await check({ config: configWith(CLOSED_PORT_URL) })).out).toBe('');
  });
});

/**
 * A run against a target whose source an adapter can read.
 *
 * M8.9's integration test is the live run against `fixtures/ledger`, and it cannot
 * exercise this: the ledger is a hand-written `node:http` server that no adapter
 * recognizes, so every observation of it is black box and no endpoint in it names a
 * handler. The target here is a local socket answering the two paths the source declares,
 * which is the smallest thing that makes a source reading real. Rule R9 holds; nothing
 * leaves loopback.
 */

/** Read as text and never executed. The adapter takes the route table out of the call sites. */
const EXPRESS_SOURCE = [
  "import express from 'express';",
  '',
  'const app = express();',
  '',
  "app.get('/api/invoices', listInvoices);",
  "app.get('/api/invoices/:id', readInvoice);",
  '',
  'function listInvoices(req, res) {',
  "  res.json({ invoices: [{ id: 'INV-1' }] });",
  '}',
  '',
  'function readInvoice(req, res) {',
  "  res.json({ id: 'INV-1', org_id: 'org-1' });",
  '}',
  '',
].join('\n');

const LEAKY_SPEC = `specVersion: '0.1'
name: 'Invoices'
actors:
  - id: owner
    description: 'A member of the owning organization'
  - id: outsider
    description: 'A member of another organization'
entities:
  - name: Invoice
    fields:
      - name: id
        type: string
      - name: org_id
        type: string
requirements:
  - id: REQ-001
    statement: 'An invoice is readable only inside its own organization'
    entities: [Invoice]
    accessRules:
      - id: AR-001-01
        actor: outsider
        action: read
        resource: Invoice
        effect: deny
`;

function sourcedConfig(baseUrl: string, sourceRoot?: string): TargetConfig {
  const body = [
    'target:',
    `  baseUrl: ${baseUrl}`,
    ...(sourceRoot === undefined ? [] : [`  sourceRoot: ${sourceRoot}`]),
    '  disposable: false',
    'actors:',
    '  - id: owner',
    '    auth:',
    '      kind: none',
    '  - id: outsider',
    '    auth:',
    '      kind: none',
    'resources:',
    '  - name: Invoice',
    '    routes:',
    '      read: /api/invoices/{id}',
    '      list: /api/invoices',
    '    instances:',
    '      - id: INV-1',
    '',
  ].join('\n');

  writeFileSync(join(dir, 'specgate.config.yaml'), body, 'utf8');
  const loaded = loadConfig('specgate.config.yaml', dir);
  if (isConfigFailure(loaded)) throw new Error(loaded.error.message);
  return loaded.config;
}

async function startTarget(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');

    if (request.url === '/api/invoices') {
      response.end(JSON.stringify({ invoices: [{ id: 'INV-1', org_id: 'org-1' }] }));
      return;
    }

    if (request.url?.startsWith('/api/invoices/') === true) {
      // Handed to anybody who asks, which is what AR-001-01 forbids.
      response.end(JSON.stringify({ id: 'INV-1', org_id: 'org-1' }));
      return;
    }

    response.end(JSON.stringify({ routes: ['/api/invoices', '/api/invoices/INV-1'] }));
  });

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = address !== null && typeof address !== 'string' ? address.port : 0;

  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function stop(server: Server): Promise<void> {
  await new Promise<void>((done) => server.close(() => done()));
}

describe('specgate check, against a target whose source can be read', () => {
  beforeEach(() => {
    mkdirSync(join(dir, 'app'), { recursive: true });
    writeFileSync(join(dir, 'app', 'server.js'), EXPRESS_SOURCE, 'utf8');
    writeFileSync(join(dir, 'spec', 'invoices.spec.yaml'), LEAKY_SPEC, 'utf8');
  });

  it('reports endpoints read from source, so the source root reaches the probe', async () => {
    // The command used to build the probe context from `baseUrl` alone, so the configured
    // source root reached the capability report and nothing else.
    const target = await startTarget();
    try {
      const { out } = await check({ config: sourcedConfig(target.baseUrl, 'app') });

      expect(out).toContain('by origin: source 2');
    } finally {
      await stop(target.server);
    }
  });

  it('reports no source endpoints when no source root is configured', async () => {
    // The negative half, so the assertion above cannot pass against a probe that reads
    // source whatever the configuration says.
    const target = await startTarget();
    try {
      const { out } = await check({ config: sourcedConfig(target.baseUrl) });

      expect(out).toContain('by origin: source 0');
    } finally {
      await stop(target.server);
    }
  });

  it('ends an access finding with the file that serves the route', async () => {
    // Step 3 of the definition of success in the product definition, end to end: a failed access
    // check citing the handler rather than the request. `app.get('/api/invoices/:id',
    // readInvoice)` is on line 6 of the source written above.
    const target = await startTarget();
    try {
      const { code, out } = await check({ config: sourcedConfig(target.baseUrl, 'app') });

      expect(code).toBe(1);
      expect(out).toContain('AR-001-01');
      expect(out).toContain('Source: server.js:6');
    } finally {
      await stop(target.server);
    }
  });

  it('ends it with the request when there is no source to cite', async () => {
    // the style guide: a file reference when source is available and a request
    // reference when it is not. Without this half the assertion above could pass against
    // a tool that attached a file reference to everything.
    const target = await startTarget();
    try {
      const { code, out } = await check({ config: sourcedConfig(target.baseUrl) });

      expect(code).toBe(1);
      expect(out).toContain('Request: GET /api/invoices/INV-1');
      expect(out).not.toContain('Source:');
    } finally {
      await stop(target.server);
    }
  });
});

describe('the run id', () => {
  it('carries seconds, so two runs seconds apart cannot collide', () => {
    // The store keys runs by id and refuses a duplicate rather than overwriting one, so
    // a minute-resolution id made two runs a few seconds apart unstorable. That is
    // exactly what happens when somebody checks, fixes something, and checks again, and
    // it is what the S7 exit criterion does on purpose.
    const first = runIdFrom('2026-08-18T18:03:38.000Z');
    const second = runIdFrom('2026-08-18T18:03:41.000Z');

    expect(first).toBe('RUN-20260818-180338');
    expect(second).toBe('RUN-20260818-180341');
    expect(first).not.toBe(second);
  });

  it('matches the shape the contract requires of a run id', () => {
    expect(runIdFrom('2026-08-18T18:03:38.000Z')).toMatch(/^RUN-[A-Za-z0-9-]+$/);
  });

  it('names the observation off the same instant, so the pair reads as one run', () => {
    const instant = '2026-08-18T18:03:38.000Z';

    expect(observationIdFrom(instant)).toBe('OBS-20260818-180338');
    expect(observationIdFrom(instant).slice(4)).toBe(runIdFrom(instant).slice(4));
  });
});

/**
 * The reset the disposability gate permits, observed rather than assumed.
 *
 * M3.7 gave the access runner a reset to call between mutating checks and no caller ever
 * supplied one, so no real run reset anything. The corpus paid for it twice: a
 * destructive check changed the application under the checks that followed, and on one
 * application a later anonymous delete passed with a 404 because the record was already
 * gone.
 *
 * The command here appends a line to a file, so the test counts real invocations rather
 * than trusting a spy on a function the command runner might not call.
 */
const MUTATING_SPEC = `specVersion: '0.1'
name: 'Invoices'
actors:
  - id: outsider
    description: 'A member of another organization'
entities:
  - name: Invoice
    fields:
      - name: id
        type: string
requirements:
  - id: REQ-001
    statement: 'An invoice may not be deleted from outside its organization'
    entities: [Invoice]
    accessRules:
      - id: AR-001-01
        actor: outsider
        action: delete
        resource: Invoice
        effect: deny
`;

/**
 * A reset command that appends to a file, so the test counts real invocations.
 *
 * Written as a script rather than as `node -e`, because a one-liner carrying a path and
 * nested quotes through YAML and a shell is the escaping trap this repository keeps
 * paying for.
 */
function writeResetScript(markerPath: string): string {
  const scriptPath = join(dir, 'reset.cjs');
  const target = JSON.stringify(markerPath);
  writeFileSync(scriptPath, `require("fs").appendFileSync(${target}, "x");\n`, 'utf8');
  return scriptPath;
}

function disposableConfig(baseUrl: string, markerPath: string, disposable = true): TargetConfig {
  const script = writeResetScript(markerPath).replaceAll('\\', '/');
  const body = [
    'target:',
    `  baseUrl: ${baseUrl}`,
    `  disposable: ${disposable}`,
    `  resetCommand: node "${script}"`,
    'actors:',
    '  - id: outsider',
    '    auth:',
    '      kind: none',
    'resources:',
    '  - name: Invoice',
    '    routes:',
    '      read: /api/invoices/{id}',
    '      delete: /api/invoices/{id}',
    '    instances:',
    '      - id: INV-1',
    '',
  ].join('\n');

  writeFileSync(join(dir, 'specgate.config.yaml'), body, 'utf8');
  const loaded = loadConfig('specgate.config.yaml', dir);
  if (isConfigFailure(loaded)) throw new Error(loaded.error.message);
  return loaded.config;
}

describe('resetting a disposable target between checks', () => {
  it('runs the configured reset command, which no run has ever done', async () => {
    writeFileSync(join(dir, 'spec', 'invoices.spec.yaml'), MUTATING_SPEC, 'utf8');
    const marker = join(dir, 'reset-count.txt');

    const target = await startTarget();
    try {
      await check({ config: disposableConfig(target.baseUrl, marker) });

      expect(existsSync(marker)).toBe(true);
    } finally {
      await stop(target.server);
    }
  });

  it('does not reset a target that is not disposable', async () => {
    // Invariant I7. Nothing may run against a target nobody said could be restored, and
    // the reset command is itself something that runs.
    writeFileSync(join(dir, 'spec', 'invoices.spec.yaml'), MUTATING_SPEC, 'utf8');
    const marker = join(dir, 'reset-count.txt');

    const target = await startTarget();
    try {
      await check({ config: disposableConfig(target.baseUrl, marker, false) });

      expect(existsSync(marker)).toBe(false);
    } finally {
      await stop(target.server);
    }
  });
});

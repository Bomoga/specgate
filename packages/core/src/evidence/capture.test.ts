import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EvidenceSchema, SpecSchema } from '../contracts/index.ts';
import { fixedDeps } from '../target/deps.ts';
import type { RequestOutcome, RequestSpec } from '../target/request.ts';
import { DEFAULT_EVIDENCE_DIR, captureHttpEvidence, createEvidenceWriter } from './capture.ts';
import { rulesFor } from './redact.ts';
import { addressOf, isBodyAddress, resolveBodyPath } from './address.ts';

const SPEC = SpecSchema.parse({
  specVersion: '0.1',
  name: 'Ledger',
  entities: [
    {
      name: 'Invoice',
      fields: [
        { name: 'org_id', type: 'string' },
        { name: 'notes', type: 'string', sensitive: true },
      ],
    },
  ],
  requirements: [],
});

const RULES = rulesFor(SPEC);

const REQUEST: RequestSpec = {
  method: 'GET',
  path: '/api/invoices/INV-1001',
  headers: { authorization: 'Bearer ledger-outsider-token', accept: 'application/json' },
};

const RESPONSE: RequestOutcome = {
  kind: 'response',
  response: {
    status: 200,
    headers: { 'content-type': 'application/json', 'set-cookie': 'session=abc' },
    body: JSON.stringify({
      id: 'INV-1001',
      org_id: 'org-1',
      total_cents: 125000,
      notes: 'Net 30, billing contact ap@northwind.example',
    }),
    truncated: false,
    durationMs: 4,
  },
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'specgate-evidence-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the captured record', () => {
  it('matches the Evidence contract', () => {
    const { evidence } = captureHttpEvidence(REQUEST, RESPONSE, RULES, fixedDeps(), {
      actorId: 'outsider',
    });

    expect(EvidenceSchema.safeParse(evidence).success).toBe(true);
  });

  it('names the actor, the request, and the response', () => {
    const { evidence } = captureHttpEvidence(REQUEST, RESPONSE, RULES, fixedDeps(), {
      actorId: 'outsider',
    });

    expect(evidence.actorId).toBe('outsider');
    expect(evidence.request?.method).toBe('GET');
    expect(evidence.request?.url).toBe('/api/invoices/INV-1001');
    expect(evidence.response?.status).toBe(200);
  });

  it('takes its timestamp and id from the injected deps, not the clock', () => {
    const deps = fixedDeps('2026-01-01T00:00:00.000Z');
    const first = captureHttpEvidence(REQUEST, RESPONSE, RULES, deps).evidence;
    const second = captureHttpEvidence(REQUEST, RESPONSE, RULES, deps).evidence;

    expect(first.capturedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(second.capturedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(first.id).toBe('EV-000001');
    expect(second.id).toBe('EV-000002');
  });

  it('lists every path it altered', () => {
    const { evidence } = captureHttpEvidence(REQUEST, RESPONSE, RULES, fixedDeps());

    expect(evidence.redactions).toContain('request.headers.authorization');
    expect(evidence.redactions).toContain('response.headers.set-cookie');
    expect(evidence.redactions).toContain('response.body.notes');
  });

  it('records a transport failure as a log rather than losing it', () => {
    const failure: RequestOutcome = {
      kind: 'transport-error',
      message: 'connect ECONNREFUSED',
      durationMs: 1,
    };
    const { evidence } = captureHttpEvidence(REQUEST, failure, RULES, fixedDeps());

    expect(evidence.kind).toBe('log');
    expect(evidence.response).toBeUndefined();
    expect(EvidenceSchema.safeParse(evidence).success).toBe(true);
  });

  it('carries the truncation flag from the response', () => {
    const truncated: RequestOutcome = {
      kind: 'response',
      response: { status: 200, headers: {}, body: 'x', truncated: true, durationMs: 1 },
    };
    const { evidence } = captureHttpEvidence(REQUEST, truncated, RULES, fixedDeps());
    expect(evidence.response?.truncated).toBe(true);
  });
});

describe('nothing sensitive reaches disk', () => {
  function writeOne(): string {
    const capture = captureHttpEvidence(REQUEST, RESPONSE, RULES, fixedDeps(), {
      actorId: 'outsider',
    });
    createEvidenceWriter({ cwd: dir }).write(capture);
    return capture.evidence.id;
  }

  it('writes no authorization header value', () => {
    writeOne();
    const written = readdirSync(join(dir, '.specgate/evidence'))
      .map((name) => readFileSync(join(dir, '.specgate/evidence', name), 'utf8'))
      .join('\n');

    expect(written).not.toContain('ledger-outsider-token');
    expect(written).toContain('[redacted]');
  });

  it('writes no field the spec marks sensitive', () => {
    writeOne();
    const written = readdirSync(join(dir, '.specgate/evidence'))
      .map((name) => readFileSync(join(dir, '.specgate/evidence', name), 'utf8'))
      .join('\n');

    expect(written).not.toContain('Net 30, billing contact');
    expect(written).not.toContain('ap@northwind.example');
  });

  it('still writes the fields that are not sensitive, so evidence stays useful', () => {
    writeOne();
    // Read by content address rather than by identifier, since D51 the body file is named
    // for its hash and the identifier names only the record beside it.
    const body = readdirSync(join(dir, '.specgate/evidence'))
      .filter((name) => name.startsWith('sha256-'))
      .map((name) => readFileSync(join(dir, '.specgate/evidence', name), 'utf8'))
      .join('\n');

    expect(body).toContain('INV-1001');
    expect(body).toContain('org-1');
    expect(body).toContain('125000');
  });

  it('leaves no other file behind that could hold the unredacted body', () => {
    writeOne();
    const names = readdirSync(join(dir, '.specgate/evidence')).sort();
    // Exactly two: the record, named for the evidence identifier, and the body, named for
    // its content address. Anything else here is a file nobody redacted.
    expect(names).toHaveLength(2);
    expect(names.filter((name) => name === 'EV-000001.record.json')).toHaveLength(1);
    expect(names.filter((name) => /^sha256-[0-9a-f]{64}\.json$/.test(name))).toHaveLength(1);
  });

  it('writes a record that still parses as Evidence', () => {
    const id = writeOne();
    const raw: unknown = JSON.parse(
      readFileSync(join(dir, '.specgate/evidence', `${id}.record.json`), 'utf8'),
    );
    expect(EvidenceSchema.safeParse(raw).success).toBe(true);
  });

  it('addresses the body by its content, and the file it wrote is there', () => {
    const capture = captureHttpEvidence(REQUEST, RESPONSE, RULES, fixedDeps());
    createEvidenceWriter({ cwd: dir }).write(capture);

    const bodyRef = capture.evidence.response?.bodyRef ?? '';
    // Per D51. The reference names no directory, no working directory, and no filesystem,
    // which is what lets the same value address a body in object storage.
    expect(isBodyAddress(bodyRef)).toBe(true);
    expect(bodyRef).not.toContain('/');

    const path = resolveBodyPath(bodyRef, { cwd: dir, evidenceDir: DEFAULT_EVIDENCE_DIR });
    expect(() => readFileSync(path, 'utf8')).not.toThrow();
  });

  it('addresses the bytes it actually wrote, so the hash can be checked', () => {
    // The address is a hash of exactly what lands on disk. If serialization and addressing
    // ever disagreed, one document would have two addresses and deduplication would be a
    // lie rather than a saving.
    const capture = captureHttpEvidence(REQUEST, RESPONSE, RULES, fixedDeps());
    createEvidenceWriter({ cwd: dir }).write(capture);

    const bodyRef = capture.evidence.response?.bodyRef ?? '';
    const written = readFileSync(
      resolveBodyPath(bodyRef, { cwd: dir, evidenceDir: DEFAULT_EVIDENCE_DIR }),
      'utf8',
    );
    expect(addressOf(written)).toBe(bodyRef);
  });

  it('gives two identical bodies one address, which is the point', () => {
    // Two runs capturing the same bytes share a body. Under the old scheme they shared one
    // by accident, because EV- is a per run counter and both runs minted EV-000001.
    const first = captureHttpEvidence(REQUEST, RESPONSE, RULES, fixedDeps());
    const second = captureHttpEvidence(REQUEST, RESPONSE, RULES, fixedDeps());
    expect(second.evidence.id).toBe(first.evidence.id);
    expect(second.evidence.response?.bodyRef).toBe(first.evidence.response?.bodyRef);

    const different: RequestOutcome = {
      kind: 'response',
      response: {
        ...RESPONSE.response,
        body: JSON.stringify({ id: 'INV-2001', org_id: 'org-2', total_cents: 1, notes: 'x' }),
      },
    };
    const other = captureHttpEvidence(REQUEST, different, RULES, fixedDeps());
    expect(other.evidence.response?.bodyRef).not.toBe(first.evidence.response?.bodyRef);
  });
});

describe('request bodies', () => {
  it('redacts a sensitive field in a request body too', () => {
    const withBody: RequestSpec = {
      ...REQUEST,
      method: 'PATCH',
      body: JSON.stringify({ notes: 'private note', org_id: 'org-1' }),
    };
    const { evidence, document } = captureHttpEvidence(withBody, RESPONSE, RULES, fixedDeps());

    expect(evidence.redactions).toContain('request.body.notes');
    expect(document.request?.body).not.toContain('private note');
    expect(document.request?.body).toContain('org-1');
  });

  it('omits the request section when there was no body', () => {
    const { document } = captureHttpEvidence(REQUEST, RESPONSE, RULES, fixedDeps());
    expect(document.request).toBeUndefined();
  });
});

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Evidence } from '../contracts/index.ts';
import type { Deps } from '../target/deps.ts';
import type { RequestOutcome, RequestSpec } from '../target/request.ts';
import { addressOf, resolveBodyPath, serializeBodyDocument } from './address.ts';
import { redactBody, redactHeaders, type RedactionRules } from './redact.ts';

/**
 * Evidence capture. Rule R7: the artifact is recorded before anything has an opinion
 * about it, so an evidence id always exists by the time a verdict is decided.
 *
 * Redaction happens here, in memory, before the single write. There is no path in
 * this file where an unredacted body reaches disk, including no temporary file,
 * per rule R8.
 */

export const DEFAULT_EVIDENCE_DIR = '.specgate/evidence';

/**
 * The shape of the file `response.bodyRef` points at.
 *
 * The contract gives Evidence a `response.bodyRef` and no place at all for a
 * request body, but M2 says the request body is captured. Rather
 * than add a contract field, both bodies live in the referenced document under named
 * keys. If an emitter ever needs the response body alone, that is a contract question
 * rather than a local fix.
 */
export interface EvidenceBodyDocument {
  readonly request?: { readonly body: string };
  readonly response?: { readonly body: string };
}

export interface CaptureOptions {
  readonly actorId?: string;
  readonly evidenceDir?: string;
  /** Root the evidence directory is resolved against. */
  readonly cwd?: string;
}

export interface CapturedEvidence {
  readonly evidence: Evidence;
  /** Present so a caller can assert on what was written without reading the file. */
  readonly document: EvidenceBodyDocument;
}

export interface EvidenceWriter {
  write(capture: CapturedEvidence): void;
}

function evidenceId(deps: Deps): string {
  return `EV-${deps.nextId()}`;
}

/**
 * Builds the record. Pure: it decides nothing and touches no disk, so a test can
 * assert on the redacted result directly.
 */
export function captureHttpEvidence(
  spec: RequestSpec,
  outcome: RequestOutcome,
  rules: RedactionRules,
  deps: Deps,
  options: CaptureOptions = {},
): CapturedEvidence {
  const id = evidenceId(deps);

  const requestHeaders = redactHeaders(spec.headers ?? {}, rules, 'request.headers');
  const requestBody =
    spec.body === undefined ? undefined : redactBody(spec.body, rules, 'request.body');

  const redactions = [...requestHeaders.redactions, ...(requestBody?.redactions ?? [])];

  const request = {
    method: spec.method,
    url: spec.path,
    headers: requestHeaders.value,
  };

  if (outcome.kind === 'transport-error') {
    const document: EvidenceBodyDocument =
      requestBody === undefined ? {} : { request: { body: requestBody.value } };

    return {
      evidence: {
        id,
        kind: 'log',
        capturedAt: deps.now(),
        ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
        request,
        redactions,
      },
      document,
    };
  }

  const { response } = outcome;
  const responseHeaders = redactHeaders(response.headers, rules, 'response.headers');
  const responseBody = redactBody(response.body, rules, 'response.body');

  const allRedactions = [...redactions, ...responseHeaders.redactions, ...responseBody.redactions];

  const document: EvidenceBodyDocument = {
    ...(requestBody === undefined ? {} : { request: { body: requestBody.value } }),
    response: { body: responseBody.value },
  };

  return {
    evidence: {
      id,
      kind: 'http',
      capturedAt: deps.now(),
      ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
      request,
      response: {
        status: response.status,
        headers: responseHeaders.value,
        // A content address of the document below, per D51. Opaque to every consumer.
        bodyRef: addressOf(serializeBodyDocument(document)),
        truncated: response.truncated,
      },
      redactions: allRedactions,
    },
    document,
  };
}

/** Writes the redacted body document. One write, already redacted, no temporary file. */
export function createEvidenceWriter(options: CaptureOptions = {}): EvidenceWriter {
  const cwd = options.cwd ?? process.cwd();
  const dir = options.evidenceDir ?? DEFAULT_EVIDENCE_DIR;

  return {
    write(capture) {
      const serialized = serializeBodyDocument(capture.document);
      // A transport error carries no response and so no reference, and its request is still
      // worth keeping on disk. Addressing it the same way costs nothing and means one rule.
      const bodyRef = capture.evidence.response?.bodyRef ?? addressOf(serialized);
      const target = resolveBodyPath(bodyRef, { cwd, evidenceDir: dir });
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, serialized, 'utf8');

      const recordTarget = join(cwd, dir, `${capture.evidence.id}.record.json`);
      writeFileSync(recordTarget, `${JSON.stringify(capture.evidence, null, 2)}\n`, 'utf8');
    },
  };
}

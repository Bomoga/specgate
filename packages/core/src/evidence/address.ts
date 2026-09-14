import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

import type { EvidenceBodyDocument } from './capture.ts';

/**
 * How an evidence body is addressed, in one place.
 *
 * **`bodyRef` is a content address rather than a path, per D51.** D31 asked for an opaque URI
 * so evidence could live in object storage, and a repository relative path is the opposite of
 * opaque: it names a filesystem, a directory layout, and a working directory, none of which an
 * object store has.
 *
 * **Wrapping the evidence identifier was considered and does not work.** `EV-` comes from
 * `deps.nextId()`, which is a per run counter, so every run mints `EV-000001` and two runs
 * genuinely point at one body. `store/prune.ts` documents that collision and unlinks a body
 * only when no surviving row still names it. A content address removes the collision instead
 * of working around it: two runs that captured the same bytes share one body because the bytes
 * are the same, which is a fact rather than an accident.
 *
 * **It is also what already crosses the plane boundary.** `P03-CONTRACTS.md` has the runner
 * requesting upload targets for bodies addressed by content hash and uploading only what the
 * control plane does not already hold. That protocol needs this shape whatever the engine
 * chose, so choosing anything else would have meant translating at the boundary.
 *
 * Everything outside this file treats the value as opaque. Nothing parses it except the
 * resolver below.
 */

/** `sha256:` and sixty four hex characters. */
const ADDRESS = /^sha256:[0-9a-f]{64}$/;

/**
 * The bytes a body document is written as.
 *
 * The address is a hash of exactly what lands on disk, so this is the only place that decides
 * the serialization. Two writers disagreeing about a trailing newline would produce two
 * addresses for one document and defeat the deduplication the address exists for.
 */
export function serializeBodyDocument(document: EvidenceBodyDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** The content address of an already serialized body. */
export function addressOf(serialized: string): string {
  return `sha256:${createHash('sha256').update(serialized, 'utf8').digest('hex')}`;
}

export function isBodyAddress(value: string): boolean {
  return ADDRESS.test(value);
}

/**
 * The file name a body is stored under locally.
 *
 * The colon is replaced because Windows will not accept one in a path segment, which is the
 * kind of thing that passes every test on a developer's machine and fails on somebody else's.
 */
export function bodyFileName(bodyRef: string): string {
  if (!isBodyAddress(bodyRef)) {
    throw new Error(`"${bodyRef}" is not an evidence content address`);
  }
  return `${bodyRef.replace(':', '-')}.json`;
}

export interface BodyLocation {
  readonly cwd: string;
  readonly evidenceDir: string;
}

/** Where a body lives on this machine. The one place a content address becomes a path. */
export function resolveBodyPath(bodyRef: string, at: BodyLocation): string {
  const dir = isAbsolute(at.evidenceDir) ? at.evidenceDir : resolve(at.cwd, at.evidenceDir);
  return join(dir, bodyFileName(bodyRef));
}

/**
 * Evidence capture, redaction, storage, and addressing. Owned by M2.
 *
 * Invariant I3: a finding without a record here is not a finding. Rule R7: the record
 * is made before the verdict. Rule R8: redaction happens on capture, so nothing
 * unredacted ever exists on disk to be cleaned up later.
 */
export * from './redact.ts';
export * from './capture.ts';
export {
  addressOf,
  bodyFileName,
  isBodyAddress,
  resolveBodyPath,
  serializeBodyDocument,
} from './address.ts';

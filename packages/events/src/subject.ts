import { isModuleId, type ModuleId } from '@intafaced/config';
import { compileSafe, safeTest } from '@intafaced/safe-regex';

/**
 * NATS SUBJECT LAW (§3, §10)
 *
 *     intafaced.<service>.<entity>.<verb>
 *
 * Four tokens. Lowercase. Dot-separated. No wildcards in a published subject.
 * `<service>` is a ModuleId from the registry — you cannot publish as a service
 * that does not exist. `<verb>` is past tense: events are facts that happened,
 * never commands. `intafaced.ledger.tx.posted`, not `intafaced.ledger.tx.post`.
 *
 * Entity tokens are validated with RE2-class matching (FH-SEC-01) so untrusted
 * subject fragments cannot ReDoS the bus parsers.
 */

export const SUBJECT_PREFIX = 'intafaced';

/** RE2 pattern for entity tokens (same shape as the former JS RegExp). */
const TOKEN_RE = compileSafe('^[a-z][a-z0-9_]*$');
const TOKEN_DESC = '^[a-z][a-z0-9_]*$';

/**
 * Past-tense verbs only. This list is deliberately closed: a new verb is a
 * design decision, and forcing it through review here keeps the event
 * vocabulary from sprawling into a second, accidental RPC layer.
 */
export const VERBS = [
  'created',
  'updated',
  'deleted',
  'posted',
  'accepted',
  'rejected',
  'cancelled',
  'filled',
  'settled',
  'failed',
  'expired',
  'locked',
  'released',
  'refunded',
  'earned',
  'approved',
  'opened',
  'closed',
  'started',
  'completed',
  'liquidated',
  'disputed',
  'resolved',
  'requested',
  'submitted',
  'confirmed',
  'reversed',
  'frozen',
  'attested',
  'sent',
  'escalated',
  'triggered',
  'paused',
  'skipped',
  'stopped',
  'crossed',
] as const;

export type Verb = (typeof VERBS)[number];

export class InvalidSubjectError extends Error {
  constructor(subject: string, reason: string) {
    super(`Invalid NATS subject "${subject}": ${reason} (law: ${SUBJECT_PREFIX}.<service>.<entity>.<verb>, §10)`);
    this.name = 'InvalidSubjectError';
  }
}

export interface ParsedSubject {
  readonly service: ModuleId;
  readonly entity: string;
  readonly verb: Verb;
  readonly subject: string;
}

/** Build a subject. Throws rather than publishing something unroutable. */
export function subject(service: ModuleId, entity: string, verb: Verb): string {
  const s = `${SUBJECT_PREFIX}.${service}.${entity}.${verb}`;
  assertValidSubject(s);
  return s;
}

export function assertValidSubject(s: string): asserts s is string {
  const parts = s.split('.');
  if (parts.length !== 4) throw new InvalidSubjectError(s, `expected 4 tokens, got ${parts.length}`);

  const [prefix, service, entity, verb] = parts as [string, string, string, string];

  if (prefix !== SUBJECT_PREFIX) throw new InvalidSubjectError(s, `prefix must be "${SUBJECT_PREFIX}"`);
  // Module ids use kebab-case (mining-pool); subject tokens allow that one hyphen.
  if (!isModuleId(service)) throw new InvalidSubjectError(s, `"${service}" is not a registered module`);
  const entityOk = safeTest(TOKEN_RE, entity, { maxInputLen: 128 });
  if (!entityOk.ok || !entityOk.matched) {
    throw new InvalidSubjectError(s, `entity "${entity}" must match ${TOKEN_DESC}`);
  }
  if (!(VERBS as readonly string[]).includes(verb)) {
    throw new InvalidSubjectError(s, `verb "${verb}" is not a declared past-tense verb`);
  }
}

export function parseSubject(s: string): ParsedSubject {
  assertValidSubject(s);
  const [, service, entity, verb] = s.split('.') as [string, ModuleId, string, Verb];
  return { service, entity, verb, subject: s };
}

/** Consumer-side wildcard, e.g. `intafaced.ledger.>` or `intafaced.trade.order.*`. */
export function wildcard(service: ModuleId, entity?: string): string {
  return entity ? `${SUBJECT_PREFIX}.${service}.${entity}.*` : `${SUBJECT_PREFIX}.${service}.>`;
}

/** JetStream stream name for a service's events. */
export function streamName(service: ModuleId, prefix = 'INTAFACED'): string {
  return `${prefix}_${service.replace(/-/g, '_').toUpperCase()}`;
}

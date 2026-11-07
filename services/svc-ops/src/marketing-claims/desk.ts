import { createHash } from 'node:crypto';
import {
  CLAIM_EVIDENCE_MISSING,
  CLAIM_NOT_FOUND,
  CLAIM_SELF_APPROVAL,
  CLAIMS_LIST_LIMIT,
  CLAIMS_STORAGE_UNCONFIGURED,
  type ClaimPublishInput,
  type ClaimRecordInput,
  type ClaimWriteOutput,
  type ClaimsList,
} from '@intafaced/contracts';
import { OPS_IDEMPOTENCY_CONFLICT, OpsError } from '../codes.js';
import { toWire, type ClaimStore, type StoredClaim } from './store.js';

export interface ClaimDeskDeps {
  readonly store: ClaimStore | undefined;
  readonly now: () => string;
}

/** The row id follows from the business key, so a record sent twice can only ever name one row. */
export function claimIdFor(key: string): string {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const asked = (c: Pick<StoredClaim, 'topic' | 'text' | 'evidence' | 'authorId'>) =>
  JSON.stringify([c.topic, c.text, c.evidence, c.authorId]);

/**
 * The marketing claims evidence register (RC-more-catalogue-24). A founder records a claim with its evidence, or without
 * one; a DIFFERENT founder publishes it (dual control), and only when it names evidence. The register shows every claim
 * with its evidence or its block. Every record, publish and refused publish is appended to a log that refuses update and
 * delete. No money moves; nothing here reads or writes the posting freeze or an account.
 */
export class ClaimDesk {
  constructor(private readonly deps: ClaimDeskDeps) {}

  private store(): ClaimStore {
    if (!this.deps.store)
      throw new OpsError(
        CLAIMS_STORAGE_UNCONFIGURED,
        'No durable storage is configured for the marketing claims register, so no claim can be recorded or published.',
      );
    return this.deps.store;
  }

  async list(): Promise<ClaimsList> {
    const items = await this.store().list(CLAIMS_LIST_LIMIT);
    return { items: items.map(toWire), asOf: this.deps.now() };
  }

  async record(actorId: string, input: ClaimRecordInput): Promise<ClaimWriteOutput> {
    const now = this.deps.now();
    const content = { topic: input.topic.trim(), text: input.text.trim(), evidence: input.evidence?.trim() || null, authorId: actorId };
    return this.store().change(async (locked) => {
      const stored = await locked.byKey(input.key);
      if (stored) {
        if (asked(stored) !== asked(content))
          throw new OpsError(OPS_IDEMPOTENCY_CONFLICT, 'this key was already used for a claim with other content');
        return { claim: toWire(stored), outcome: 'replayed' as const };
      }
      const row: StoredClaim = {
        id: claimIdFor(input.key),
        key: input.key,
        ...content,
        status: 'draft',
        createdAt: now,
        approverId: null,
        publishedAt: null,
      };
      await locked.insert(row, { op: 'record', outcome: 'created', actorId, at: now });
      return { claim: toWire(row), outcome: 'created' as const };
    });
  }

  /**
   * A second founder publishes a recorded claim. Publishing one already published is a logged no-op. A refused publish is
   * logged too: the log row commits, then the refusal is thrown.
   */
  async publish(actorId: string, input: ClaimPublishInput): Promise<ClaimWriteOutput> {
    const now = this.deps.now();
    const result = await this.store().change(
      async (
        locked,
      ): Promise<ClaimWriteOutput | { refused: typeof CLAIM_SELF_APPROVAL | typeof CLAIM_EVIDENCE_MISSING; message: string }> => {
        const row = await locked.byId(input.id);
        if (!row) throw new OpsError(CLAIM_NOT_FOUND, `no claim ${input.id}`);
        const entry = { op: 'publish', actorId, at: now } as const;
        if (row.status === 'published') {
          await locked.log(row.id, { ...entry, outcome: 'noop' });
          return { claim: toWire(row), outcome: 'noop' as const };
        }
        const refusal: { refused: typeof CLAIM_SELF_APPROVAL | typeof CLAIM_EVIDENCE_MISSING; message: string } | null =
          row.authorId === actorId
            ? { refused: CLAIM_SELF_APPROVAL, message: 'the founder who recorded this claim cannot publish it: a second founder does' }
            : row.evidence === null
              ? { refused: CLAIM_EVIDENCE_MISSING, message: 'this claim names no evidence, so it cannot be published' }
              : null;
        if (refusal) {
          await locked.log(row.id, { ...entry, outcome: 'refused', code: refusal.refused });
          return refusal;
        }
        const next = await locked.publish(row.id, actorId, now, { ...entry, outcome: 'published' });
        return { claim: toWire(next), outcome: 'published' as const };
      },
    );
    if ('refused' in result) throw new OpsError(result.refused, result.message);
    return result;
  }
}

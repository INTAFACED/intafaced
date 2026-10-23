/**
 * Incident postmortems (SP-status-02): what happened, written after an incident is resolved and published on the status
 * page under it. One per incident. Writing on an incident that is still open is refused
 * (`status.postmortem_requires_resolved`): the account is of something that is over.
 *
 * A draft moves by version: an edit names the version it read (`status.postmortem_version_stale` otherwise), and writing
 * the same words at the version they already have is a replay. Publishing works as a notice does: the author asks
 * identity for an approval bound to the exact version and wording (`proposal`), a different founder approves it, and a
 * founder other than the approver publishes, spending it once. A published postmortem is never edited.
 */
import { createHash } from 'node:crypto';
import type { NoticeApprovalConsumer } from '../notices/board.js';

export const POSTMORTEM_PUBLISH_ACTION = 'notify.postmortem.publish';
export const POSTMORTEM_BODY_MAX = 20_000;
export const POSTMORTEMS_LIST_MAX = 200;

export type PostmortemCode =
  | 'status.postmortem_requires_resolved'
  | 'status.postmortem_incident_unknown'
  | 'status.postmortem_invalid'
  | 'status.postmortem_version_stale'
  | 'status.postmortem_published'
  | 'status.postmortem_not_found'
  | 'status.postmortem_approval_spent'
  | 'status.postmortem_approval_unavailable'
  | 'status.postmortem_publish_same_operator';

export class PostmortemError extends Error {
  constructor(readonly code: PostmortemCode) {
    super(code);
    this.name = 'PostmortemError';
  }
}

export type Postmortem = {
  readonly incidentId: string;
  readonly body: string;
  readonly version: number;
  readonly status: 'draft' | 'published';
  readonly writtenBy: string;
  readonly writtenAt: string;
  readonly publishedAt: string | null;
};

export type PostmortemProposal = {
  readonly actionType: typeof POSTMORTEM_PUBLISH_ACTION;
  readonly targetService: 'svc-notify';
  readonly targetId: string;
  readonly expectedVersion: string;
  readonly payloadHash: string;
};

export interface PostmortemStore {
  get(incidentId: string): Promise<Postmortem | null>;
  /**
   * Writes version `expectedVersion + 1` when the stored version is `expectedVersion` (0: none yet) and it is a draft.
   * Answers the stored row, or `stale` / `published` when it cannot.
   */
  write(
    row: { incidentId: string; body: string; writtenBy: string; at: Date },
    expectedVersion: number,
  ): Promise<Postmortem | 'stale' | 'published'>;
  approvalOutcome(approvalId: string): Promise<'published' | 'refused_same_operator' | null>;
  /** Records that the approver tried to publish: the approval is spent and nothing is published. */
  recordRefusal(approvalId: string, incidentId: string, publisherId: string): Promise<void>;
  /**
   * Records the approval's use and publishes the draft at `version`, both or neither: `spent` when the approval was already
   * used, `stale` when the draft is not at that version any more.
   */
  publishWith(
    incidentId: string,
    version: number,
    patch: { approvalId: string; publishedBy: string; at: Date },
  ): Promise<'published' | 'spent' | 'stale'>;
  published(limit: number): Promise<readonly Postmortem[]>;
  /** Drafts and published, newest written first: the founders' desk. */
  list(limit: number): Promise<readonly Postmortem[]>;
}

export type IncidentState = 'unknown' | 'open' | 'resolved';

/** The status of an incident as the notice board holds it: a published incident's first entry, open or resolved. */
export type IncidentLookup = (incidentId: string) => Promise<IncidentState>;

export const postmortemTarget = (incidentId: string) => `postmortem:${incidentId}`;

export function postmortemHash(row: Pick<Postmortem, 'incidentId' | 'body' | 'version'>): string {
  const payload = JSON.stringify({ kind: 'postmortem', incidentId: row.incidentId, body: row.body, version: row.version });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

export class Postmortems {
  constructor(
    private readonly store: PostmortemStore,
    private readonly incident: IncidentLookup,
    private readonly approvals: NoticeApprovalConsumer | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async requireResolved(incidentId: string): Promise<void> {
    const state = await this.incident(incidentId);
    if (state === 'unknown') throw new PostmortemError('status.postmortem_incident_unknown');
    if (state === 'open') throw new PostmortemError('status.postmortem_requires_resolved');
  }

  async write(by: string, input: { incidentId: string; body: string; expectedVersion: number }): Promise<Postmortem> {
    const body = input.body.trim();
    if (body === '' || body.length > POSTMORTEM_BODY_MAX || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 0)
      throw new PostmortemError('status.postmortem_invalid');
    await this.requireResolved(input.incidentId);
    const current = await this.store.get(input.incidentId);
    // The same words at the version they already have: a lost reply sent again.
    if (current && current.body === body && current.version === input.expectedVersion + 1) return current;
    if (current?.status === 'published') throw new PostmortemError('status.postmortem_published');
    const stored = await this.store.write({ incidentId: input.incidentId, body, writtenBy: by, at: this.now() }, input.expectedVersion);
    if (stored === 'published') throw new PostmortemError('status.postmortem_published');
    if (stored === 'stale') throw new PostmortemError('status.postmortem_version_stale');
    return stored;
  }

  async get(incidentId: string): Promise<Postmortem | null> {
    return this.store.get(incidentId);
  }

  /** The exact approval a draft's publish spends. */
  async proposal(incidentId: string): Promise<PostmortemProposal> {
    const row = await this.store.get(incidentId);
    if (!row) throw new PostmortemError('status.postmortem_not_found');
    if (row.status === 'published') throw new PostmortemError('status.postmortem_published');
    return {
      actionType: POSTMORTEM_PUBLISH_ACTION,
      targetService: 'svc-notify',
      targetId: postmortemTarget(incidentId),
      expectedVersion: String(row.version),
      payloadHash: postmortemHash(row),
    };
  }

  /**
   * Spends a second founder's approval once. The approver cannot also publish: that refusal spends the approval too, as a
   * notice's does. The same approval sent again by the founder it published for answers the published postmortem.
   */
  async publish(publisherId: string, input: { incidentId: string; approvalId: string; operationId: string }): Promise<Postmortem> {
    const row = await this.store.get(input.incidentId);
    if (!row) throw new PostmortemError('status.postmortem_not_found');
    const used = await this.store.approvalOutcome(input.approvalId);
    if (used === 'published' && row.status === 'published') return row;
    if (used)
      throw new PostmortemError(
        used === 'refused_same_operator' ? 'status.postmortem_publish_same_operator' : 'status.postmortem_approval_spent',
      );
    if (row.status === 'published') throw new PostmortemError('status.postmortem_published');
    if (!this.approvals) throw new PostmortemError('status.postmortem_approval_unavailable');
    let approval;
    try {
      approval = await this.approvals.consume({
        approvalId: input.approvalId,
        operationId: input.operationId,
        payloadHash: postmortemHash(row),
        targetService: 'svc-notify',
        targetId: postmortemTarget(input.incidentId),
        expectedVersion: String(row.version),
      });
    } catch {
      throw new PostmortemError('status.postmortem_approval_spent');
    }
    const sameOperator =
      approval.approverId == null ||
      approval.approverId === publisherId ||
      approval.approverId === approval.requesterId ||
      approval.kind === 'same_person' ||
      (approval.status !== 'CONSUMED' && approval.status !== 'APPROVED');
    if (sameOperator) {
      await this.store.recordRefusal(input.approvalId, input.incidentId, publisherId);
      throw new PostmortemError('status.postmortem_publish_same_operator');
    }
    const outcome = await this.store.publishWith(input.incidentId, row.version, {
      approvalId: input.approvalId,
      publishedBy: publisherId,
      at: this.now(),
    });
    if (outcome === 'spent') throw new PostmortemError('status.postmortem_approval_spent');
    if (outcome === 'stale') throw new PostmortemError('status.postmortem_version_stale');
    return (await this.store.get(input.incidentId))!;
  }

  /** The founders' desk: every postmortem, newest written first. */
  async list(limit: number): Promise<readonly Postmortem[]> {
    return this.store.list(Math.min(Math.max(1, limit), POSTMORTEMS_LIST_MAX));
  }

  /** What a visitor reads: published postmortems, newest first. */
  async published(limit: number): Promise<readonly Postmortem[]> {
    return this.store.published(Math.min(Math.max(1, limit), POSTMORTEMS_LIST_MAX));
  }
}

export class MemoryPostmortemStore implements PostmortemStore {
  private readonly rows = new Map<string, Postmortem & { approvalId: string | null }>();
  private readonly uses = new Map<string, 'published' | 'refused_same_operator'>();

  async get(incidentId: string) {
    const row = this.rows.get(incidentId);
    if (!row) return null;
    const { approvalId: _approval, ...out } = row;
    return out;
  }
  async write(row: { incidentId: string; body: string; writtenBy: string; at: Date }, expectedVersion: number) {
    const current = this.rows.get(row.incidentId);
    if (current?.status === 'published') return 'published' as const;
    if ((current?.version ?? 0) !== expectedVersion) return 'stale' as const;
    this.rows.set(row.incidentId, {
      incidentId: row.incidentId,
      body: row.body,
      version: expectedVersion + 1,
      status: 'draft',
      writtenBy: row.writtenBy,
      writtenAt: row.at.toISOString(),
      publishedAt: null,
      approvalId: null,
    });
    return (await this.get(row.incidentId))!;
  }
  async approvalOutcome(approvalId: string) {
    return this.uses.get(approvalId) ?? null;
  }
  async recordRefusal(approvalId: string) {
    if (!this.uses.has(approvalId)) this.uses.set(approvalId, 'refused_same_operator');
  }
  async publishWith(incidentId: string, version: number, patch: { approvalId: string; at: Date }) {
    if (this.uses.has(patch.approvalId)) return 'spent' as const;
    const row = this.rows.get(incidentId);
    if (!row || row.status !== 'draft' || row.version !== version) return 'stale' as const;
    this.uses.set(patch.approvalId, 'published');
    this.rows.set(incidentId, { ...row, status: 'published', publishedAt: patch.at.toISOString(), approvalId: patch.approvalId });
    return 'published' as const;
  }
  async published(limit: number) {
    return [...this.rows.values()]
      .filter((row) => row.status === 'published')
      .sort((a, b) => b.publishedAt!.localeCompare(a.publishedAt!))
      .slice(0, limit)
      .map(({ approvalId: _approval, ...out }) => out);
  }
  async list(limit: number) {
    return [...this.rows.values()]
      .sort((a, b) => b.writtenAt.localeCompare(a.writtenAt))
      .slice(0, limit)
      .map(({ approvalId: _approval, ...out }) => out);
  }
}

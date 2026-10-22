/**
 * Public notices. Drafts stay off the signed-out reads. Publishing spends an
 * identity approval from a different operator. A published row is not edited;
 * a correction is a new id. No notice copy is seeded here.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import type { CommandLog } from '../preferences/account.js';
import {
  ChangelogError,
  CHANGELOG_LIST_MAX,
  normaliseChangelog,
  retiredEndpoints,
  upcomingEntries,
  type Changelog,
  type ChangelogCode,
  type ChangelogInput,
  type RetiredEndpoint,
} from './changelog.js';
import { buildStatusFeed, clampStatusDays, openIncidentRoots, STATUS_FEED_ROWS_MAX, type StatusFeed } from './status-feed.js';

export const NOTICE_KINDS = ['announcement', 'maintenance', 'incident', 'changelog'] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];
export type NoticeStatus = 'draft' | 'published';

/** What a status notice can be about. Components with no notice stay `unknown`. */
export const STATUS_COMPONENTS = ['api', 'webhooks', 'console'] as const;
export type StatusComponent = (typeof STATUS_COMPONENTS)[number];

export const INCIDENT_IMPACTS = ['none', 'minor', 'major', 'critical'] as const;
export type IncidentImpact = (typeof INCIDENT_IMPACTS)[number];

/**
 * Funding incident status flow. A scoped incident (one asset on one network)
 * names its phase on every entry; only the closing entry reads `resolved`.
 */
export const INCIDENT_PHASES = ['investigating', 'identified', 'update', 'monitoring', 'resolved'] as const;
export type IncidentPhase = (typeof INCIDENT_PHASES)[number];

/** Asset symbol and network slug as the asset registry spells them. */
export const NOTICE_ASSET_PATTERN = /^[A-Z0-9]{2,20}$/;
export const NOTICE_NETWORK_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;

export type NoticeCode =
  | 'notify.notices_unavailable'
  | 'notify.notices_limit_invalid'
  | 'notify.notice_not_found'
  | 'notify.notice_kind_unknown'
  | 'notify.notice_copy_unset'
  | 'notify.notice_publish_approval_unavailable'
  | 'notify.notice_publish_same_operator'
  | 'notify.notice_approval_spent'
  | 'notify.notice_published_immutable'
  | 'notify.notice_incident_fields_invalid'
  | 'notify.notice_component_unknown'
  | 'notify.notice_impact_unset'
  | 'notify.notice_parent_invalid'
  | 'notify.notice_scope_invalid'
  | 'notify.notice_phase_unset'
  | 'notify.notice_phase_invalid'
  | ChangelogCode;

export class NoticeError extends Error {
  constructor(readonly code: NoticeCode) {
    super(code);
    this.name = 'NoticeError';
  }
}

export type NoticeWire = {
  readonly id: string;
  readonly kind: NoticeKind;
  readonly title: string;
  readonly body: string;
  readonly status: NoticeStatus;
  readonly publishedAt: string | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly version: number;
  /** Incident and maintenance: the asset this notice is about. Null when it is not scoped to one asset and network. */
  readonly asset: string | null;
  /** Set together with `asset`: the network of that asset. */
  readonly network: string | null;
  /** Scoped incidents: where this entry puts the incident. Null on every other notice. */
  readonly phase: IncidentPhase | null;
  /** Changelog entries only: area, breaking flag, dates, examples and retirements. Null on every other kind. */
  readonly changelog: Changelog | null;
};

export type NoticeRow = {
  id: string;
  kind: NoticeKind;
  title: string;
  body: string;
  status: NoticeStatus;
  publishedAt: Date | null;
  startsAt: Date | null;
  endsAt: Date | null;
  version: number;
  /** Incident only. The severity this entry reports. Null on a notice that names none. */
  impact: IncidentImpact | null;
  /** Incident and maintenance. The status components this notice is about. */
  components: readonly StatusComponent[];
  /** Incident only. The first entry of the incident this one updates. Null on the first entry. */
  parentId: string | null;
  /** Incident only. This entry closes the incident. */
  resolves: boolean;
  /** Incident and maintenance. Asset and network the notice is about; both null or both set. */
  asset: string | null;
  network: string | null;
  /** Scoped incident only. Required on every entry of a scoped incident. */
  phase: IncidentPhase | null;
  /** Changelog only. Null on a notice that carries none, including changelog entries written before this field. */
  changelog: Changelog | null;
  authorId: string;
  clientRequestId: string;
  publishClientRequestId: string | null;
  approvalId: string | null;
  createdAt: Date;
};

export type NoticeStatusRead = {
  readonly incidents: readonly NoticeWire[];
  readonly maintenance: readonly NoticeWire[];
};

/** One open funding incident on an asset and network: its first entry and its newest. */
export type FundingIncident = { readonly root: NoticeWire; readonly latest: NoticeWire };

export type FundingNotices = {
  readonly asset: string;
  readonly network: string;
  readonly incidents: readonly FundingIncident[];
  readonly maintenance: readonly NoticeWire[];
};

export interface NoticeApprovalConsumer {
  consume(input: ActionApprovalConsumeInput): Promise<ActionApproval>;
}

export interface NoticeStore {
  insert(row: NoticeRow): Promise<void>;
  findByDraftRequest(authorId: string, clientRequestId: string): Promise<NoticeRow | null>;
  findById(id: string): Promise<NoticeRow | null>;
  listPublished(kind: NoticeKind | null, limit: number): Promise<readonly NoticeRow[]>;
  /** Published incident and maintenance rows, newest first, for the status feed. */
  listPublishedForStatus(limit: number): Promise<readonly NoticeRow[]>;
  markPublished(id: string, patch: { publishedAt: Date; approvalId: string; publishClientRequestId: string }): Promise<void>;
  approvalOutcome(approvalId: string): Promise<'published' | 'refused_same_operator' | null>;
  recordApproval(
    approvalId: string,
    noticeId: string,
    publisherId: string,
    outcome: 'published' | 'refused_same_operator',
  ): Promise<'inserted' | 'exists'>;
}

export const NOTICES_LIST_LIMIT_MAX = 50;

export function clampNoticeLimit(limit: number): number {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    throw new NoticeError('notify.notices_limit_invalid');
  }
  return Math.min(limit, NOTICES_LIST_LIMIT_MAX);
}

function isKind(value: string): value is NoticeKind {
  return (NOTICE_KINDS as readonly string[]).includes(value);
}

export function toNoticeWire(row: NoticeRow): NoticeWire {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    status: row.status,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    version: row.version,
    asset: row.asset,
    network: row.network,
    phase: row.phase,
    changelog: row.changelog,
  };
}

export function noticeIsOpen(row: NoticeRow, now: Date): boolean {
  if (row.status !== 'published') return false;
  if (row.startsAt && row.startsAt.getTime() > now.getTime()) return false;
  if (row.endsAt && row.endsAt.getTime() <= now.getTime()) return false;
  return true;
}

function payloadHash(row: NoticeRow): string {
  const status =
    row.impact || row.components.length > 0 || row.parentId || row.resolves
      ? { impact: row.impact, components: row.components, parentId: row.parentId, resolves: row.resolves }
      : undefined;
  const scope = row.asset !== null || row.phase !== null ? { asset: row.asset, network: row.network, phase: row.phase } : undefined;
  const payload = JSON.stringify({
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    version: row.version,
    ...(status ? { status } : {}),
    ...(scope ? { scope } : {}),
    ...(row.changelog ? { changelog: row.changelog } : {}),
  });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

const CHANGELOG_ROWS_MAX = 500;

/** Changelog fields belong to changelog notices alone, and a changelog notice names its area. */
function changelogFields(kind: NoticeKind, input: ChangelogInput | null | undefined): Changelog | null {
  if (kind !== 'changelog') {
    if (input != null) throw new NoticeError('notify.changelog_fields_invalid');
    return null;
  }
  if (input == null) return null;
  try {
    return normaliseChangelog(input);
  } catch (err) {
    if (err instanceof ChangelogError) throw new NoticeError(err.code);
    throw err;
  }
}

function parseOptionalInstant(value: string | null | undefined, code: NoticeCode): Date | null {
  if (value == null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new NoticeError(code);
  return date;
}

type PublishReplay = { ok: true; notice: NoticeWire } | { ok: false; code: NoticeCode };

export class MemoryNoticeStore implements NoticeStore {
  private readonly rows = new Map<string, NoticeRow>();
  private readonly approvals = new Map<string, 'published' | 'refused_same_operator'>();

  async insert(row: NoticeRow): Promise<void> {
    this.rows.set(row.id, row);
  }

  async findByDraftRequest(authorId: string, clientRequestId: string): Promise<NoticeRow | null> {
    for (const row of this.rows.values()) {
      if (row.authorId === authorId && row.clientRequestId === clientRequestId) return row;
    }
    return null;
  }

  async findById(id: string): Promise<NoticeRow | null> {
    return this.rows.get(id) ?? null;
  }

  async listPublished(kind: NoticeKind | null, limit: number): Promise<readonly NoticeRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.status === 'published' && (kind == null || row.kind === kind))
      .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0) || a.id.localeCompare(b.id))
      .slice(0, limit);
  }

  async listPublishedForStatus(limit: number): Promise<readonly NoticeRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.status === 'published' && (row.kind === 'incident' || row.kind === 'maintenance'))
      .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0) || a.id.localeCompare(b.id))
      .slice(0, limit);
  }

  async markPublished(id: string, patch: { publishedAt: Date; approvalId: string; publishClientRequestId: string }): Promise<void> {
    const row = this.rows.get(id);
    if (!row || row.status !== 'draft') throw new NoticeError('notify.notice_published_immutable');
    row.status = 'published';
    row.publishedAt = patch.publishedAt;
    row.approvalId = patch.approvalId;
    row.publishClientRequestId = patch.publishClientRequestId;
  }

  async approvalOutcome(approvalId: string): Promise<'published' | 'refused_same_operator' | null> {
    return this.approvals.get(approvalId) ?? null;
  }

  async recordApproval(
    approvalId: string,
    _noticeId: string,
    _publisherId: string,
    outcome: 'published' | 'refused_same_operator',
  ): Promise<'inserted' | 'exists'> {
    if (this.approvals.has(approvalId)) return 'exists';
    this.approvals.set(approvalId, outcome);
    return 'inserted';
  }
}

export class NoticeBoard {
  constructor(
    private readonly store: NoticeStore,
    private readonly approvals: NoticeApprovalConsumer | null,
    private readonly commands: CommandLog,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async draft(
    authorId: string,
    input: {
      kind: string;
      title: string;
      body: string;
      startsAt?: string | null;
      endsAt?: string | null;
      impact?: string | null;
      components?: readonly string[] | null;
      parentId?: string | null;
      resolves?: boolean | null;
      asset?: string | null;
      network?: string | null;
      phase?: string | null;
      changelog?: ChangelogInput | null;
      clientRequestId: string;
    },
  ): Promise<NoticeWire> {
    const existing = await this.store.findByDraftRequest(authorId, input.clientRequestId);
    if (existing) return toNoticeWire(existing);
    if (!isKind(input.kind)) throw new NoticeError('notify.notice_kind_unknown');
    const title = input.title.trim();
    const body = input.body.trim();
    if (!title || !body) throw new NoticeError('notify.notice_copy_unset');
    const status = await this.statusFields({ ...input, kind: input.kind });
    const changelog = changelogFields(input.kind, input.changelog);
    const row: NoticeRow = {
      id: randomUUID(),
      kind: input.kind,
      title,
      body,
      status: 'draft',
      publishedAt: null,
      startsAt: parseOptionalInstant(input.startsAt, 'notify.notice_copy_unset'),
      endsAt: parseOptionalInstant(input.endsAt, 'notify.notice_copy_unset'),
      version: 1,
      ...status,
      changelog,
      authorId,
      clientRequestId: input.clientRequestId,
      publishClientRequestId: null,
      approvalId: null,
      createdAt: this.now(),
    };
    await this.store.insert(row);
    return toNoticeWire(row);
  }

  /**
   * Impact, components, thread and close flag. Components belong to incident and
   * maintenance notices; the rest belong to incidents alone. A component list
   * with no impact on an incident is refused, so a component never reads as
   * affected by an unnamed severity.
   */
  private async statusFields(input: {
    kind: NoticeKind;
    impact?: string | null;
    components?: readonly string[] | null;
    parentId?: string | null;
    resolves?: boolean | null;
    asset?: string | null;
    network?: string | null;
    phase?: string | null;
  }): Promise<Pick<NoticeRow, 'impact' | 'components' | 'parentId' | 'resolves' | 'asset' | 'network' | 'phase'>> {
    const components = [...new Set(input.components ?? [])];
    const impact = input.impact ?? null;
    const parentId = input.parentId ?? null;
    const resolves = input.resolves === true;
    const incident = input.kind === 'incident';
    if (!incident && (impact !== null || parentId !== null || resolves)) throw new NoticeError('notify.notice_incident_fields_invalid');
    if (!incident && input.kind !== 'maintenance' && components.length > 0) throw new NoticeError('notify.notice_incident_fields_invalid');
    if (components.some((c) => !(STATUS_COMPONENTS as readonly string[]).includes(c)))
      throw new NoticeError('notify.notice_component_unknown');
    if (impact !== null && !(INCIDENT_IMPACTS as readonly string[]).includes(impact))
      throw new NoticeError('notify.notice_incident_fields_invalid');
    if (incident && components.length > 0 && impact === null) throw new NoticeError('notify.notice_impact_unset');
    let parent: NoticeRow | null = null;
    if (parentId !== null) {
      parent = await this.store.findById(parentId);
      if (!parent || parent.kind !== 'incident' || parent.parentId !== null) throw new NoticeError('notify.notice_parent_invalid');
    }
    const scope = this.scopeFields(input, incident, resolves, parent);
    return { impact: impact as IncidentImpact | null, components: components as StatusComponent[], parentId, resolves, ...scope };
  }

  /**
   * Asset and network scope, and the incident phase. Scope belongs to incident
   * and maintenance notices and is set as a pair. An update of a scoped incident
   * keeps the incident's scope; it may repeat it but never name another. Every
   * entry of a scoped incident names its phase, and `resolved` is the phase of
   * the closing entry and of no other.
   */
  private scopeFields(
    input: { kind: NoticeKind; asset?: string | null; network?: string | null; phase?: string | null },
    incident: boolean,
    resolves: boolean,
    parent: NoticeRow | null,
  ): Pick<NoticeRow, 'asset' | 'network' | 'phase'> {
    let asset = input.asset ?? null;
    let network = input.network ?? null;
    const phase = input.phase ?? null;
    if ((asset === null) !== (network === null)) throw new NoticeError('notify.notice_scope_invalid');
    if (asset !== null && !incident && input.kind !== 'maintenance') throw new NoticeError('notify.notice_scope_invalid');
    if (asset !== null && (!NOTICE_ASSET_PATTERN.test(asset) || !NOTICE_NETWORK_PATTERN.test(network!)))
      throw new NoticeError('notify.notice_scope_invalid');
    if (phase !== null && !incident) throw new NoticeError('notify.notice_incident_fields_invalid');
    if (phase !== null && !(INCIDENT_PHASES as readonly string[]).includes(phase)) throw new NoticeError('notify.notice_phase_invalid');
    if (parent !== null) {
      if (asset !== null && (asset !== parent.asset || network !== parent.network)) throw new NoticeError('notify.notice_scope_invalid');
      asset = parent.asset;
      network = parent.network;
    }
    if (incident && asset !== null) {
      if (phase === null) throw new NoticeError('notify.notice_phase_unset');
      if ((phase === 'resolved') !== resolves) throw new NoticeError('notify.notice_phase_invalid');
    } else if (phase !== null) {
      // A phase on an incident with no asset and network has nothing to scope it.
      throw new NoticeError('notify.notice_scope_invalid');
    }
    return { asset, network, phase: phase as IncidentPhase | null };
  }

  async notices(input: { kind?: string | null; limit: number }): Promise<readonly NoticeWire[]> {
    const limit = clampNoticeLimit(input.limit);
    const kind = input.kind == null || input.kind === '' ? null : input.kind;
    if (kind != null && !isKind(kind)) throw new NoticeError('notify.notice_kind_unknown');
    const rows = await this.store.listPublished(kind, limit);
    return rows.map(toNoticeWire);
  }

  async notice(id: string): Promise<NoticeWire> {
    const row = await this.store.findById(id);
    if (!row || row.status !== 'published') throw new NoticeError('notify.notice_not_found');
    return toNoticeWire(row);
  }

  /** Published changelog entries, newest first, optionally narrowed to one area or to breaking entries. */
  async changelog(input: { area?: string | null; breaking?: boolean | null; limit: number }): Promise<readonly NoticeWire[]> {
    const limit = Math.min(clampNoticeLimit(input.limit), CHANGELOG_LIST_MAX);
    const area = input.area == null || input.area === '' ? null : input.area;
    const rows = await this.store.listPublished('changelog', CHANGELOG_ROWS_MAX);
    return rows
      .map(toNoticeWire)
      .filter(
        (entry) => (area === null || entry.changelog?.area === area) && (input.breaking !== true || entry.changelog?.breaking === true),
      )
      .slice(0, limit);
  }

  /** Breaking entries not yet in effect, soonest first, and every endpoint a published entry retires. */
  async upcomingChanges(at: Date = this.now()): Promise<{ upcoming: readonly NoticeWire[]; retired: readonly RetiredEndpoint[] }> {
    const entries = (await this.store.listPublished('changelog', CHANGELOG_ROWS_MAX)).map(toNoticeWire);
    return { upcoming: upcomingEntries(entries, at), retired: retiredEndpoints(entries) };
  }

  async noticeStatus(at: Date = this.now()): Promise<NoticeStatusRead> {
    const published = await this.store.listPublishedForStatus(STATUS_FEED_ROWS_MAX);
    return {
      // An incident is open until an update closes it; its updates are not listed again.
      incidents: openIncidentRoots(published, at).map(toNoticeWire),
      maintenance: published.filter((row) => row.kind === 'maintenance' && noticeIsOpen(row, at)).map(toNoticeWire),
    };
  }

  /**
   * Open funding incidents and maintenance for one asset on one network, for
   * the deposit and withdraw banners. A notice on another network of the same
   * asset is not shown. Each incident carries its newest entry, so the banner
   * reads the current phase.
   */
  async fundingNotices(input: { asset: string; network: string }, at: Date = this.now()): Promise<FundingNotices> {
    if (!NOTICE_ASSET_PATTERN.test(input.asset) || !NOTICE_NETWORK_PATTERN.test(input.network))
      throw new NoticeError('notify.notice_scope_invalid');
    const published = await this.store.listPublishedForStatus(STATUS_FEED_ROWS_MAX);
    const onScope = (row: NoticeRow) => row.asset === input.asset && row.network === input.network;
    const incidents = openIncidentRoots(published, at)
      .filter(onScope)
      .map((root) => {
        const entries = published.filter((row) => row.id === root.id || row.parentId === root.id);
        const latest = entries.reduce((a, b) => (b.publishedAt!.getTime() > a.publishedAt!.getTime() ? b : a));
        return { root: toNoticeWire(root), latest: toNoticeWire(latest) };
      });
    const maintenance = published.filter((row) => row.kind === 'maintenance' && onScope(row) && noticeIsOpen(row, at)).map(toNoticeWire);
    return { asset: input.asset, network: input.network, incidents, maintenance };
  }

  async statusFeed(input: { days: number }, at: Date = this.now()): Promise<StatusFeed> {
    const days = clampStatusDays(input.days);
    const rows = await this.store.listPublishedForStatus(STATUS_FEED_ROWS_MAX);
    return buildStatusFeed(rows, at, days);
  }

  async currentAnnouncement(at: Date = this.now()): Promise<NoticeWire | null> {
    const rows = await this.store.listPublished('announcement', NOTICES_LIST_LIMIT_MAX);
    const open = rows.filter((row) => noticeIsOpen(row, at));
    const current = open[0];
    return current ? toNoticeWire(current) : null;
  }

  async publish(
    publisherId: string,
    input: { id: string; clientRequestId: string; approvalId: string; operationId: string },
  ): Promise<NoticeWire> {
    const replay = await this.commands.find(publisherId, 'publishNotice', input.clientRequestId);
    if (replay) {
      const stored = replay as PublishReplay;
      if (!stored.ok) throw new NoticeError(stored.code);
      return stored.notice;
    }
    const fail = async (code: NoticeCode): Promise<never> => {
      await this.commands.put(publisherId, 'publishNotice', input.clientRequestId, { ok: false, code } satisfies PublishReplay);
      throw new NoticeError(code);
    };
    const row = await this.store.findById(input.id);
    if (!row) return fail('notify.notice_not_found');
    if (row.status === 'published') return fail('notify.notice_published_immutable');
    if (row.parentId) {
      const parent = await this.store.findById(row.parentId);
      if (!parent || parent.status !== 'published') return fail('notify.notice_parent_invalid');
    }
    if (!this.approvals) return fail('notify.notice_publish_approval_unavailable');
    const spent = await this.store.approvalOutcome(input.approvalId);
    if (spent) return fail('notify.notice_approval_spent');
    let approval: ActionApproval;
    try {
      approval = await this.approvals.consume({
        approvalId: input.approvalId,
        operationId: input.operationId,
        payloadHash: payloadHash(row),
        targetService: 'svc-notify',
        targetId: row.id,
        expectedVersion: String(row.version),
      });
    } catch {
      return fail('notify.notice_approval_spent');
    }
    const sameOperator =
      approval.approverId == null ||
      approval.approverId === publisherId ||
      approval.approverId === approval.requesterId ||
      approval.kind === 'same_person' ||
      (approval.status !== 'CONSUMED' && approval.status !== 'APPROVED');
    if (sameOperator) {
      await this.store.recordApproval(input.approvalId, row.id, publisherId, 'refused_same_operator');
      return fail('notify.notice_publish_same_operator');
    }
    const recorded = await this.store.recordApproval(input.approvalId, row.id, publisherId, 'published');
    if (recorded === 'exists') return fail('notify.notice_approval_spent');
    await this.store.markPublished(row.id, {
      publishedAt: this.now(),
      approvalId: input.approvalId,
      publishClientRequestId: input.clientRequestId,
    });
    const published = await this.store.findById(row.id);
    if (!published) return fail('notify.notice_not_found');
    const wire = toNoticeWire(published);
    await this.commands.put(publisherId, 'publishNotice', input.clientRequestId, { ok: true, notice: wire } satisfies PublishReplay);
    return wire;
  }
}

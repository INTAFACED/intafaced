/**
 * The incident desk (SP-status-02): incidents on svc-notify's notice board as the founders see them (drafts too), the
 * templates they keep, and the identity approvals each publish spends. Pure and browser safe.
 *
 * An incident is its first entry and the updates that name it. Nothing is published by one person: the author asks
 * identity for an approval bound to the exact draft, a different founder approves it, and svc-notify spends it once.
 */
import type { Part } from '@/lib/desk/part';

export const IMPACTS = ['none', 'minor', 'major', 'critical'] as const;
export type Impact = (typeof IMPACTS)[number];

export interface OperatorNotice {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly status: 'draft' | 'published';
  readonly publishedAt: string | null;
  readonly version: number;
  readonly impact: Impact | null;
  readonly components: readonly string[];
  readonly parentId: string | null;
  readonly resolves: boolean;
  readonly authorId: string;
  readonly createdAt: string;
}

export interface IncidentTemplate {
  readonly id: string;
  readonly name: string;
  readonly group: string | null;
  readonly title: string;
  readonly body: string;
  readonly impact: Impact | null;
  readonly components: readonly string[];
  readonly definedAt: string;
}

/** The part of an identity approval the desk shows and spends. */
export interface PublishApproval {
  readonly approvalId: string;
  readonly operationId: string;
  readonly targetId: string;
  readonly status: string;
  readonly requesterId: string;
  readonly approverId: string | null;
  readonly createdAt: string;
}

export interface IncidentDeskView {
  readonly notices: Part<readonly OperatorNotice[]>;
  readonly templates: Part<readonly IncidentTemplate[]>;
  readonly components: Part<readonly { readonly id: string; readonly name: string }[]>;
  readonly approvals: Part<readonly PublishApproval[]>;
  /** The signed-in founder, so the desk can say "you asked". */
  readonly me: string;
  readonly asOf: string;
}

export type IncidentDeskReply =
  | { readonly ok: true; readonly what: string; readonly approval?: PublishApproval }
  | {
      readonly ok: false;
      readonly title: string;
      readonly body: string;
      readonly next: string;
      readonly code: string | null;
      readonly changed: 'no' | 'unknown';
    };

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const isImpact = (v: unknown): v is Impact | null => v === null || (IMPACTS as readonly unknown[]).includes(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

export function readOperatorNotices(raw: unknown): OperatorNotice[] | null {
  if (!Array.isArray(raw)) return null;
  const out: OperatorNotice[] = [];
  for (const n of raw) {
    if (
      !isRecord(n) ||
      typeof n.id !== 'string' ||
      typeof n.kind !== 'string' ||
      typeof n.title !== 'string' ||
      typeof n.body !== 'string' ||
      (n.status !== 'draft' && n.status !== 'published') ||
      !strOrNull(n.publishedAt) ||
      !Number.isInteger(n.version) ||
      !isImpact(n.impact) ||
      !strings(n.components) ||
      !strOrNull(n.parentId) ||
      typeof n.resolves !== 'boolean' ||
      typeof n.authorId !== 'string' ||
      typeof n.createdAt !== 'string'
    )
      return null;
    out.push({
      id: n.id,
      kind: n.kind,
      title: n.title,
      body: n.body,
      status: n.status,
      publishedAt: n.publishedAt,
      version: n.version as number,
      impact: n.impact,
      components: n.components,
      parentId: n.parentId,
      resolves: n.resolves,
      authorId: n.authorId,
      createdAt: n.createdAt,
    });
  }
  return out;
}

export function readTemplates(raw: unknown): IncidentTemplate[] | null {
  if (!Array.isArray(raw)) return null;
  const out: IncidentTemplate[] = [];
  for (const t of raw) {
    if (
      !isRecord(t) ||
      typeof t.id !== 'string' ||
      typeof t.name !== 'string' ||
      !strOrNull(t.group) ||
      typeof t.title !== 'string' ||
      typeof t.body !== 'string' ||
      !isImpact(t.impact) ||
      !strings(t.components) ||
      typeof t.definedAt !== 'string'
    )
      return null;
    out.push({
      id: t.id,
      name: t.name,
      group: t.group,
      title: t.title,
      body: t.body,
      impact: t.impact,
      components: t.components,
      definedAt: t.definedAt,
    });
  }
  return out;
}

/** The publish approval part of an identity approval row, or null when it is not one. */
export function publishApprovalOf(raw: unknown): PublishApproval | null {
  if (!isRecord(raw)) return null;
  const { approvalId, operationId, targetId, status, requesterId, approverId, createdAt } = raw;
  if (
    typeof approvalId !== 'string' ||
    typeof operationId !== 'string' ||
    typeof targetId !== 'string' ||
    typeof status !== 'string' ||
    typeof requesterId !== 'string' ||
    !strOrNull(approverId) ||
    typeof createdAt !== 'string'
  )
    return null;
  return { approvalId, operationId, targetId, status, requesterId, approverId, createdAt };
}

export type IncidentState = 'draft' | 'open' | 'resolved';

export interface Incident {
  readonly root: OperatorNotice;
  /** The first entry, then its updates in the order they were written. */
  readonly entries: readonly OperatorNotice[];
  readonly state: IncidentState;
}

/** Incidents newest first: a draft first entry is a draft incident; a published resolving update makes it resolved. */
export function incidentsFrom(notices: readonly OperatorNotice[]): Incident[] {
  const incidents = notices.filter((n) => n.kind === 'incident');
  return incidents
    .filter((n) => n.parentId === null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    .map((root) => {
      const updates = incidents
        .filter((n) => n.parentId === root.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const state: IncidentState =
        root.status === 'draft' ? 'draft' : updates.some((u) => u.status === 'published' && u.resolves) ? 'resolved' : 'open';
      return { root, entries: [root, ...updates], state };
    });
}

/**
 * The approval that decides a draft's publish now: the newest approved one (it can be spent), else the newest pending,
 * else the newest of any. An approved one is never hidden behind a newer request.
 */
export function approvalFor(noticeId: string, approvals: readonly PublishApproval[]): PublishApproval | null {
  const mine = approvals.filter((a) => a.targetId === noticeId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return mine.find((a) => a.status === 'APPROVED') ?? mine.find((a) => a.status === 'PENDING') ?? mine[0] ?? null;
}

/** The id of the newest entry written, drafts included, or null on an empty desk. */
export function newestEntry(notices: readonly OperatorNotice[]): string | null {
  return [...notices].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))[0]?.id ?? null;
}

/** Templates by group for the picker; a template with no group is listed under "No group". */
export function templateGroups(templates: readonly IncidentTemplate[]): { group: string; templates: IncidentTemplate[] }[] {
  const groups = new Map<string, IncidentTemplate[]>();
  for (const t of templates) {
    const key = t.group ?? 'No group';
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  return [...groups.entries()].map(([group, list]) => ({ group, templates: list }));
}

export interface IncidentDraftInput {
  /** The newest entry the founder saw when writing it (null on an empty desk); see `draftKey`. */
  readonly basis?: string | null;
  readonly title: string;
  readonly body: string;
  readonly impact: Impact | null;
  readonly components: readonly string[];
  readonly parentId: string | null;
  readonly resolves: boolean;
}

/** Checked before it leaves the browser; svc-notify checks it again. */
export function checkIncidentDraft(input: IncidentDraftInput): { ok: true } | { ok: false; why: string } {
  if (input.title.trim() === '' || input.title.trim().length > 200) return { ok: false, why: 'The title is 1 to 200 characters.' };
  if (input.body.trim() === '' || input.body.trim().length > 8000) return { ok: false, why: 'The message is 1 to 8000 characters.' };
  if (input.parentId === null && input.components.length > 0 && input.impact === null)
    return { ok: false, why: 'Name the impact: an incident that names components has to say how bad it is.' };
  return { ok: true };
}

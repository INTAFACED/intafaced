/**
 * AC-release-access-02 — prerequisites, availability and due windows,
 * per-learner extensions, on curriculum slugs the lesson screen already opens.
 *
 * No row means no extra gate. Programme enrolment checks stay in
 * `curriculum/programmes.ts` and are not replaced here.
 */
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { AcademyError } from '../errors.js';
import { hasCurriculumSlug } from '../curriculum/catalog.js';

export type ReleaseState = 'locked' | 'unlocked' | 'started' | 'completed';
export type ReleaseLock = 'prerequisite' | 'window';

export type ItemWindow = {
  readonly availableFrom: Date;
  readonly availableUntil: Date;
  readonly dueAt: Date | null;
};

export type PrerequisiteEdge = {
  readonly itemSlug: string;
  readonly prerequisiteSlug: string;
};

export type ReleaseDecision = {
  readonly state: ReleaseState;
  readonly missing: string[];
  readonly lock: ReleaseLock | null;
};

/** What the lesson card reads. Null dates mean the owner has not set them. */
export type ItemReleaseView = ReleaseDecision & {
  readonly itemSlug: string;
  readonly availableFrom: Date | null;
  readonly availableUntil: Date | null;
  readonly dueAt: Date | null;
  readonly extendedUntil: Date | null;
  readonly reason: string | null;
  readonly grantedAt: Date | null;
  readonly grantedBy: string | null;
};

export function requireCurriculumSlug(slug: string): string {
  const trimmed = slug.trim();
  if (!hasCurriculumSlug(trimmed)) {
    throw new AcademyError('Unknown curriculum item', 'academy.curriculum_not_found');
  }
  return trimmed;
}

/** Blank after trim is not a reason. Never invent one. */
export function requireExtensionReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw new AcademyError('academy.reason_required', 'academy.reason_required');
  }
  return trimmed;
}

/**
 * Both ends, or neither. One side is not a published window.
 * End must be strictly after the start. A due outside that span is not a window.
 */
export function clearedOrWindow(input: {
  readonly availableFrom: Date | null;
  readonly availableUntil: Date | null;
  readonly dueAt: Date | null;
}): ItemWindow | null {
  const { availableFrom, availableUntil, dueAt } = input;
  if (availableFrom === null && availableUntil === null && dueAt === null) return null;
  if (availableFrom === null || availableUntil === null) {
    throw new AcademyError('availability start and end are both required', 'academy.window_invalid');
  }
  if (!(availableUntil.getTime() > availableFrom.getTime())) {
    throw new AcademyError('availability end must be after the start', 'academy.window_invalid');
  }
  if (dueAt) {
    const due = dueAt.getTime();
    if (due < availableFrom.getTime() || due > availableUntil.getTime()) {
      throw new AcademyError('due is outside the availability window', 'academy.window_invalid');
    }
  }
  return { availableFrom, availableUntil, dueAt };
}

/** Deduped, sorted. A self-edge is a cycle and is refused before a write. */
export function normalizePrerequisites(itemSlug: string, raw: readonly string[]): string[] {
  const item = requireCurriculumSlug(itemSlug);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    const slug = requireCurriculumSlug(value);
    if (slug === item) {
      throw new AcademyError(`academy.prerequisite_cycle path=${item}>${item}`, 'academy.prerequisite_cycle');
    }
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out.sort();
}

/** First cycle as item, prerequisite, item… or null when the graph is acyclic. */
export function findPrerequisiteCycle(edges: readonly PrerequisiteEdge[]): string[] | null {
  const adjacent = new Map<string, string[]>();
  for (const edge of edges) {
    const next = adjacent.get(edge.itemSlug) ?? [];
    next.push(edge.prerequisiteSlug);
    adjacent.set(edge.itemSlug, next);
    if (!adjacent.has(edge.prerequisiteSlug)) adjacent.set(edge.prerequisiteSlug, []);
  }
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    color.set(node, 1);
    stack.push(node);
    for (const next of adjacent.get(node) ?? []) {
      const seen = color.get(next) ?? 0;
      if (seen === 1) {
        const at = stack.indexOf(next);
        return [...stack.slice(at), next];
      }
      if (seen === 0) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(node, 2);
    return null;
  };
  for (const node of adjacent.keys()) {
    if ((color.get(node) ?? 0) === 0) {
      const found = visit(node);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Extension lengthens the binding end (the earlier of availability end and due).
 * It does not open the item before availableFrom, and it does not invent a window.
 */
export function assertExtensionExtends(window: ItemWindow, extendedUntil: Date): void {
  if (Number.isNaN(extendedUntil.getTime())) {
    throw new AcademyError('extension end is not a time', 'academy.window_invalid');
  }
  const until = window.availableUntil.getTime();
  const due = window.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bound = Math.min(until, due);
  if (!(extendedUntil.getTime() > bound)) {
    throw new AcademyError('extension does not pass the published window', 'academy.window_invalid');
  }
}

function outsideWindow(window: ItemWindow, extensionUntil: Date | null, now: Date): boolean {
  const t = now.getTime();
  if (t < window.availableFrom.getTime()) return true;
  const until = window.availableUntil.getTime();
  const due = window.dueAt?.getTime() ?? null;
  const ext = extensionUntil?.getTime() ?? null;
  const openUntil = ext !== null && ext > until ? ext : until;
  if (t >= openUntil) return true;
  if (due !== null) {
    const dueBound = ext !== null && ext > due ? ext : due;
    if (t >= dueBound) return true;
  }
  return false;
}

export function decideRelease(input: {
  readonly completed: boolean;
  readonly started: boolean;
  readonly missing: readonly string[];
  readonly window: ItemWindow | null;
  readonly extensionUntil: Date | null;
  readonly now: Date;
}): ReleaseDecision {
  if (input.completed) return { state: 'completed', missing: [], lock: null };
  const missing = [...input.missing].sort();
  if (missing.length > 0) return { state: 'locked', missing, lock: 'prerequisite' };
  if (input.window && outsideWindow(input.window, input.extensionUntil, input.now)) {
    return { state: 'locked', missing: [], lock: 'window' };
  }
  if (input.started) return { state: 'started', missing: [], lock: null };
  return { state: 'unlocked', missing: [], lock: null };
}

export function refuseRelease(decision: ReleaseDecision): void {
  if (decision.lock === 'prerequisite') {
    throw new AcademyError(`academy.prerequisite_unmet missing=${decision.missing.join(',')}`, 'academy.prerequisite_unmet');
  }
  if (decision.lock === 'window') {
    throw new AcademyError('academy.window_invalid outside the published window', 'academy.window_invalid');
  }
}

export type ItemExtensionRecord = {
  readonly userId: string;
  readonly itemSlug: string;
  readonly revision: number;
  readonly reason: string;
  readonly extendedUntil: Date;
  readonly clientRequestId: string;
};

type WindowRow = { available_from: Date; available_until: Date; due_at: Date | null };
type ExtensionRow = {
  user_id: string;
  item_slug: string;
  revision: number;
  reason: string;
  extended_until: Date;
  client_request_id: string;
};
type ExtensionViewRow = {
  extended_until: Date;
  reason: string;
  granted_at: Date;
  granted_by: string;
};

/** Same learner, item, reason, and end. A difference is not a replay. */
function extensionReplayAgrees(
  stored: { item_slug: string; reason: string; extended_until: Date },
  requested: { itemSlug: string; reason: string; extendedUntil: Date },
): boolean {
  return (
    stored.item_slug === requested.itemSlug &&
    stored.reason === requested.reason &&
    stored.extended_until.getTime() === requested.extendedUntil.getTime()
  );
}

export class ReleaseAccess {
  constructor(private readonly sql: Sql) {}

  async itemRelease(input: { userId: string; itemSlug: string; now?: Date }): Promise<ItemReleaseView> {
    const itemSlug = requireCurriculumSlug(input.itemSlug);
    return this.load(input.userId, itemSlug, input.now ?? new Date());
  }

  /** Same decision as completion. A lock throws before a lesson body is read. */
  async assertMayRead(input: { userId: string; itemSlug: string; now?: Date }): Promise<void> {
    const itemSlug = requireCurriculumSlug(input.itemSlug);
    const view = await this.load(input.userId, itemSlug, input.now ?? new Date());
    refuseRelease(view);
  }

  /**
   * A signed-out read (AC-catalogue-01). An item with a prerequisite depends on the reader's own record, so it
   * asks for sign-in; a published window applies to everyone; anything else is open.
   */
  async assertMayReadSignedOut(input: { itemSlug: string; now?: Date }): Promise<void> {
    const itemSlug = requireCurriculumSlug(input.itemSlug);
    const prerequisites = await this.sql<Array<{ prerequisite_slug: string }>>`
      SELECT prerequisite_slug FROM academy.item_prerequisites WHERE item_slug = ${itemSlug} LIMIT 1
    `;
    if (prerequisites.length > 0) {
      throw new AcademyError('academy.sign_in_required this item has a prerequisite', 'academy.sign_in_required');
    }
    const windows = await this.sql<WindowRow[]>`
      SELECT available_from, available_until, due_at FROM academy.item_windows WHERE item_slug = ${itemSlug}
    `;
    const row = windows[0];
    const window = row ? { availableFrom: row.available_from, availableUntil: row.available_until, dueAt: row.due_at } : null;
    refuseRelease(
      decideRelease({ completed: false, started: false, missing: [], window, extensionUntil: null, now: input.now ?? new Date() }),
    );
  }

  async assertMayComplete(input: { userId: string; itemSlug: string; now?: Date }): Promise<void> {
    await this.assertMayRead(input);
  }

  async setItemPrerequisites(input: { itemSlug: string; prerequisites: readonly string[] }): Promise<{
    itemSlug: string;
    prerequisites: string[];
  }> {
    const itemSlug = requireCurriculumSlug(input.itemSlug);
    const prerequisites = normalizePrerequisites(itemSlug, input.prerequisites);
    await transaction(this.sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('academy.item_prerequisites', 0))`;
      await tx`DELETE FROM academy.item_prerequisites WHERE item_slug = ${itemSlug}`;
      for (const prerequisiteSlug of prerequisites) {
        await tx`
          INSERT INTO academy.item_prerequisites (item_slug, prerequisite_slug)
          VALUES (${itemSlug}, ${prerequisiteSlug})
        `;
      }
      const edges = await tx<Array<{ item_slug: string; prerequisite_slug: string }>>`
        SELECT item_slug, prerequisite_slug FROM academy.item_prerequisites
      `;
      const cycle = findPrerequisiteCycle(edges.map((edge) => ({ itemSlug: edge.item_slug, prerequisiteSlug: edge.prerequisite_slug })));
      if (cycle) {
        throw new AcademyError(`academy.prerequisite_cycle path=${cycle.join('>')}`, 'academy.prerequisite_cycle');
      }
    });
    return { itemSlug, prerequisites };
  }

  async setItemWindow(input: {
    itemSlug: string;
    availableFrom: Date | null;
    availableUntil: Date | null;
    dueAt: Date | null;
  }): Promise<{ itemSlug: string; availableFrom: Date | null; availableUntil: Date | null; dueAt: Date | null }> {
    const itemSlug = requireCurriculumSlug(input.itemSlug);
    const window = clearedOrWindow(input);
    if (!window) {
      await this.sql`DELETE FROM academy.item_windows WHERE item_slug = ${itemSlug}`;
      return { itemSlug, availableFrom: null, availableUntil: null, dueAt: null };
    }
    await this.sql`
      INSERT INTO academy.item_windows (item_slug, available_from, available_until, due_at)
      VALUES (${itemSlug}, ${window.availableFrom}, ${window.availableUntil}, ${window.dueAt})
      ON CONFLICT (item_slug) DO UPDATE SET
        available_from = EXCLUDED.available_from,
        available_until = EXCLUDED.available_until,
        due_at = EXCLUDED.due_at
    `;
    return { itemSlug, availableFrom: window.availableFrom, availableUntil: window.availableUntil, dueAt: window.dueAt };
  }

  /**
   * Replay key is the learner, the item, and clientRequestId.
   * The same item, reason, and end returns the first grant.
   * A reused id whose item, reason, or end differs is refused and writes nothing.
   */
  async grantItemExtension(input: {
    userId: string;
    itemSlug: string;
    reason: string;
    extendedUntil: Date;
    clientRequestId: string;
    operatorId: string;
    now?: Date;
  }): Promise<ItemExtensionRecord> {
    const itemSlug = requireCurriculumSlug(input.itemSlug);
    const reason = requireExtensionReason(input.reason);
    const clientRequestId = input.clientRequestId.trim();
    if (!clientRequestId) {
      throw new AcademyError('clientRequestId is required', 'academy.window_invalid');
    }
    if (Number.isNaN(input.extendedUntil.getTime())) {
      throw new AcademyError('extension end is not a time', 'academy.window_invalid');
    }
    const now = input.now ?? new Date();
    return transaction(this.sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:${clientRequestId}:extension-request`}, 0))`;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:${itemSlug}:extension`}, 0))`;
      const replay = await tx<ExtensionRow[]>`
        SELECT user_id, item_slug, revision, reason, extended_until, client_request_id
          FROM academy.item_extensions
         WHERE user_id = ${input.userId} AND client_request_id = ${clientRequestId}
      `;
      if (replay.length > 0) {
        const requested = { itemSlug, reason, extendedUntil: input.extendedUntil };
        if (replay.some((row) => !extensionReplayAgrees(row, requested))) {
          throw new AcademyError('academy.window_invalid replay item, reason, or end differs', 'academy.window_invalid');
        }
        return toExtension(replay[0]!);
      }
      const windows = await tx<WindowRow[]>`
        SELECT available_from, available_until, due_at
          FROM academy.item_windows
         WHERE item_slug = ${itemSlug}
      `;
      const row = windows[0];
      if (!row) {
        throw new AcademyError('academy.window_invalid nothing to extend', 'academy.window_invalid');
      }
      const window: ItemWindow = {
        availableFrom: row.available_from,
        availableUntil: row.available_until,
        dueAt: row.due_at,
      };
      assertExtensionExtends(window, input.extendedUntil);
      const next = await tx<Array<{ revision: number }>>`
        SELECT COALESCE(MAX(revision), 0) + 1 AS revision
          FROM academy.item_extensions
         WHERE user_id = ${input.userId} AND item_slug = ${itemSlug}
      `;
      const revision = Number(next[0]?.revision ?? 1);
      const inserted = await tx<ExtensionRow[]>`
        INSERT INTO academy.item_extensions (
          user_id, item_slug, revision, reason, extended_until, client_request_id, granted_by, granted_at
        ) VALUES (
          ${input.userId}, ${itemSlug}, ${revision}, ${reason}, ${input.extendedUntil},
          ${clientRequestId}, ${input.operatorId}, ${now}
        )
        RETURNING user_id, item_slug, revision, reason, extended_until, client_request_id
      `;
      return toExtension(inserted[0]!);
    });
  }

  private async load(userId: string, itemSlug: string, now: Date): Promise<ItemReleaseView> {
    const prereqRows = await this.sql<Array<{ prerequisite_slug: string }>>`
      SELECT prerequisite_slug FROM academy.item_prerequisites WHERE item_slug = ${itemSlug}
    `;
    const required = prereqRows.map((row) => row.prerequisite_slug);
    let missing: string[] = [];
    if (required.length > 0) {
      const done = await this.sql<Array<{ item_slug: string }>>`
        SELECT item_slug FROM academy.cert_item_completions
         WHERE user_id = ${userId} AND item_slug IN ${this.sql(required)}
      `;
      const have = new Set(done.map((row) => row.item_slug));
      missing = required.filter((slug) => !have.has(slug));
    }
    const windows = await this.sql<WindowRow[]>`
      SELECT available_from, available_until, due_at
        FROM academy.item_windows
       WHERE item_slug = ${itemSlug}
    `;
    const extensions = await this.sql<ExtensionViewRow[]>`
      SELECT extended_until, reason, granted_at, granted_by
        FROM academy.item_extensions
       WHERE user_id = ${userId} AND item_slug = ${itemSlug}
       ORDER BY revision DESC
       LIMIT 1
    `;
    const started = await this.sql<Array<{ started: boolean }>>`
      SELECT (
        EXISTS (
          SELECT 1 FROM academy.learning_touches
           WHERE user_id = ${userId} AND item_slug = ${itemSlug}
        )
        OR EXISTS (
          SELECT 1 FROM academy.learning_state
           WHERE user_id = ${userId} AND last_item_slug = ${itemSlug}
        )
      ) AS started
    `;
    const completed = await this.sql<Array<{ completed: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM academy.cert_item_completions
         WHERE user_id = ${userId} AND item_slug = ${itemSlug}
      ) AS completed
    `;
    const windowRow = windows[0];
    const extension = extensions[0];
    const decision = decideRelease({
      completed: completed[0]?.completed === true,
      started: started[0]?.started === true,
      missing,
      window: windowRow
        ? {
            availableFrom: windowRow.available_from,
            availableUntil: windowRow.available_until,
            dueAt: windowRow.due_at,
          }
        : null,
      extensionUntil: extension?.extended_until ?? null,
      now,
    });
    return {
      itemSlug,
      ...decision,
      availableFrom: windowRow?.available_from ?? null,
      availableUntil: windowRow?.available_until ?? null,
      dueAt: windowRow?.due_at ?? null,
      extendedUntil: extension?.extended_until ?? null,
      reason: extension?.reason ?? null,
      grantedAt: extension?.granted_at ?? null,
      grantedBy: extension?.granted_by ?? null,
    };
  }
}

function toExtension(row: ExtensionRow): ItemExtensionRecord {
  return {
    userId: row.user_id,
    itemSlug: row.item_slug,
    revision: Number(row.revision),
    reason: row.reason,
    extendedUntil: row.extended_until,
    clientRequestId: row.client_request_id,
  };
}

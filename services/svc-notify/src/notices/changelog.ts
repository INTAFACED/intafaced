/**
 * Developer changelog entries. A changelog notice can carry the product area it
 * belongs to, whether it breaks callers, the endpoints and scopes it adds, the
 * dates it was added and takes effect, a before-and-after example, a migration
 * note and the endpoints it retires. A release date is never filled in for the
 * author: an entry with none reads `releaseOn: null` and is not listed as
 * upcoming.
 */

export const CHANGELOG_AREAS = [
  'trading',
  'market_data',
  'account',
  'wallet',
  'payments',
  'webhooks',
  'websocket',
  'fix',
  'authentication',
] as const;
export type ChangelogArea = (typeof CHANGELOG_AREAS)[number];

export type ChangelogCode =
  | 'notify.changelog_fields_invalid'
  | 'notify.changelog_area_unknown'
  | 'notify.changelog_area_unset'
  | 'notify.changelog_date_invalid'
  | 'notify.changelog_example_incomplete'
  | 'notify.changelog_migration_note_unset';

/** The stored and wire shape. Dates are calendar days (`YYYY-MM-DD`). */
export type Changelog = {
  readonly area: ChangelogArea;
  readonly breaking: boolean;
  readonly endpoints: string[];
  readonly scopes: string[];
  readonly addedOn: string | null;
  readonly releaseOn: string | null;
  readonly before: string | null;
  readonly after: string | null;
  readonly migrationNote: string | null;
  readonly retired: string[];
};

export type ChangelogInput = {
  area?: string | null;
  breaking?: boolean | null;
  endpoints?: readonly string[] | null;
  scopes?: readonly string[] | null;
  addedOn?: string | null;
  releaseOn?: string | null;
  before?: string | null;
  after?: string | null;
  migrationNote?: string | null;
  retired?: readonly string[] | null;
};

export const CHANGELOG_LIST_MAX = 50;
const ITEMS_MAX = 50;
const ITEM_MAX = 200;
const EXAMPLE_MAX = 4000;
const NOTE_MAX = 4000;

export class ChangelogError extends Error {
  constructor(readonly code: ChangelogCode) {
    super(code);
    this.name = 'ChangelogError';
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function day(value: string | null | undefined): string | null {
  if (value == null || value === '') return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!DAY.test(value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new ChangelogError('notify.changelog_date_invalid');
  }
  return value;
}

function list(values: readonly string[] | null | undefined): string[] {
  const out = [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))];
  if (out.length > ITEMS_MAX || out.some((value) => value.length > ITEM_MAX)) throw new ChangelogError('notify.changelog_fields_invalid');
  return out;
}

function text(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) throw new ChangelogError('notify.changelog_fields_invalid');
  return trimmed;
}

/** Validate an author's changelog fields. A breaking entry needs a migration note; the dates are checked, never defaulted. */
export function normaliseChangelog(input: ChangelogInput): Changelog {
  const area = input.area ?? null;
  if (area === null || area === '') throw new ChangelogError('notify.changelog_area_unset');
  if (!(CHANGELOG_AREAS as readonly string[]).includes(area)) throw new ChangelogError('notify.changelog_area_unknown');
  const addedOn = day(input.addedOn);
  const releaseOn = day(input.releaseOn);
  if (addedOn && releaseOn && releaseOn < addedOn) throw new ChangelogError('notify.changelog_date_invalid');
  const before = text(input.before, EXAMPLE_MAX);
  const after = text(input.after, EXAMPLE_MAX);
  if ((before === null) !== (after === null)) throw new ChangelogError('notify.changelog_example_incomplete');
  const breaking = input.breaking === true;
  const migrationNote = text(input.migrationNote, NOTE_MAX);
  if (breaking && migrationNote === null) throw new ChangelogError('notify.changelog_migration_note_unset');
  return {
    area: area as ChangelogArea,
    breaking,
    endpoints: list(input.endpoints),
    scopes: list(input.scopes),
    addedOn,
    releaseOn,
    before,
    after,
    migrationNote,
    retired: list(input.retired),
  };
}

/** What a changelog notice reads as, for a row that stored these fields. */
export function fromStored(value: unknown): Changelog | null {
  if (value == null) return null;
  return normaliseChangelog(value as ChangelogInput);
}

export type ChangelogEntryRef = {
  readonly id: string;
  readonly title: string;
  readonly publishedAt: string | null;
  readonly changelog: Changelog | null;
};

export type RetiredEndpoint = {
  readonly endpoint: string;
  readonly entryId: string;
  readonly title: string;
  readonly releaseOn: string | null;
};

/** The calendar day of an instant, in UTC. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Breaking entries whose release date has not passed. An entry with no release date is never upcoming. Soonest first. */
export function upcomingEntries<T extends ChangelogEntryRef>(entries: readonly T[], at: Date): T[] {
  const today = utcDay(at);
  return entries
    .filter((entry) => entry.changelog?.breaking === true && entry.changelog.releaseOn !== null && entry.changelog.releaseOn >= today)
    .sort((a, b) => (a.changelog?.releaseOn ?? '').localeCompare(b.changelog?.releaseOn ?? '') || a.id.localeCompare(b.id));
}

/** Every endpoint a published entry retires, with the entry that retires it. The same endpoint named twice keeps the earliest release date. */
export function retiredEndpoints(entries: readonly ChangelogEntryRef[]): RetiredEndpoint[] {
  const byEndpoint = new Map<string, RetiredEndpoint>();
  for (const entry of entries) {
    for (const endpoint of entry.changelog?.retired ?? []) {
      const next: RetiredEndpoint = { endpoint, entryId: entry.id, title: entry.title, releaseOn: entry.changelog?.releaseOn ?? null };
      const known = byEndpoint.get(endpoint);
      // A dated retirement outranks an undated one; between two dates the earlier wins.
      if (!known || (next.releaseOn !== null && (known.releaseOn === null || next.releaseOn < known.releaseOn)))
        byEndpoint.set(endpoint, next);
    }
  }
  return [...byEndpoint.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint));
}

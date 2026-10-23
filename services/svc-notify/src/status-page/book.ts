/**
 * The public status page's book (SP-status-01): the founders' definition (components and three owner values) and the
 * readings that give each component a state.
 *
 * Nothing is seeded. A definition change names the revision it read; the same change replayed under the same revision
 * returns the stored state, and a change from a stale revision is refused. A reading is keyed by (component, instant): a
 * replay is one row, and a different state or source at the same instant is refused.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import {
  statusPageConfigureKey,
  type NoticeCategory,
  type StatusComponentDefinition,
  type StatusPageConfigureInput,
  type StatusPageErrorCode,
  type StatusReadingState,
} from '@intafaced/contracts';

/** Readings ahead of the service clock by more than this are refused: a source cannot report the future. */
export const STATUS_READING_SKEW_MS = 60_000;

export class StatusPageError extends Error {
  constructor(readonly code: StatusPageErrorCode) {
    super(code);
    this.name = 'StatusPageError';
  }
}

export type StatusDefinition = {
  readonly components: readonly StatusComponentDefinition[];
  readonly componentCap: number | null;
  readonly stalenessSeconds: number | null;
  readonly uptimeDays: number | null;
  readonly challengeBits: number | null;
  readonly subscribeRatePerHour: number | null;
  /** Notice categories a founder files an announcement under; null when none is set (the kinds alone). */
  readonly noticeCategories: readonly NoticeCategory[] | null;
  readonly revision: number;
  readonly updatedAt: string | null;
};

export type StatusReading = {
  readonly componentId: string;
  readonly state: StatusReadingState;
  readonly observedAt: Date;
  readonly source: string;
};

export type StatusPageChange = {
  readonly input: StatusPageConfigureInput;
  readonly by: string;
  readonly at: string;
};

export interface StatusPageBook {
  definition(): Promise<StatusDefinition>;
  /** Throws StatusPageError for a stale revision or a list the cap refuses. */
  configure(change: StatusPageChange): Promise<StatusDefinition>;
  /** Throws StatusPageError for an unknown component, a future instant or a conflicting replay. */
  record(reading: StatusReading, by: string, at: Date): Promise<StatusReading>;
  /** The newest reading of each component, whatever its age. */
  latest(): Promise<readonly StatusReading[]>;
  /** For the uptime strip: per component and UTC day from `since`, the distinct states read that day. At most one row per pair. */
  daily(since: Date): Promise<readonly StatusDay[]>;
}

export type StatusDay = { readonly componentId: string; readonly date: string; readonly states: readonly StatusReadingState[] };

const blank = (): StatusDefinition => ({
  components: [],
  componentCap: null,
  stalenessSeconds: null,
  uptimeDays: null,
  challengeBits: null,
  subscribeRatePerHour: null,
  noticeCategories: null,
  revision: 0,
  updatedAt: null,
});

type Values = Omit<StatusDefinition, 'revision' | 'updatedAt'>;

/** The definition after a change, refused when the change would leave components above (or without) a cap. */
export function applyStatusChange(prior: StatusDefinition, input: StatusPageConfigureInput): Values {
  const next: Values = {
    components: input.components ?? prior.components,
    componentCap: input.componentCap === undefined ? prior.componentCap : input.componentCap,
    stalenessSeconds: input.stalenessSeconds === undefined ? prior.stalenessSeconds : input.stalenessSeconds,
    uptimeDays: input.uptimeDays === undefined ? prior.uptimeDays : input.uptimeDays,
    challengeBits: input.challengeBits === undefined ? prior.challengeBits : input.challengeBits,
    subscribeRatePerHour: input.subscribeRatePerHour === undefined ? prior.subscribeRatePerHour : input.subscribeRatePerHour,
    noticeCategories: input.noticeCategories === undefined ? prior.noticeCategories : input.noticeCategories,
  };
  if (next.components.length > 0 && next.componentCap === null) throw new StatusPageError('status.component_cap_unset');
  if (next.componentCap !== null && next.components.length > next.componentCap) throw new StatusPageError('status.component_cap_reached');
  return next;
}

const valuesOf = (v: Values) => [
  v.components,
  v.componentCap,
  v.stalenessSeconds,
  v.uptimeDays,
  v.challengeBits,
  v.subscribeRatePerHour,
  v.noticeCategories,
];
const sameValues = (a: Values, b: Values): boolean => JSON.stringify(valuesOf(a)) === JSON.stringify(valuesOf(b));

/** What identifies one change: its fields and reason. The actor and the time are not part of it. */
export function statusFingerprint(input: StatusPageConfigureInput): string {
  const { expectedRevision: _revision, ...rest } = input;
  const fields = [
    'components',
    'componentCap',
    'stalenessSeconds',
    'uptimeDays',
    'challengeBits',
    'subscribeRatePerHour',
    'reason',
  ] as const;
  const named: unknown[] = fields.map((field) => (rest[field] === undefined ? null : [field, rest[field]]));
  // Added after the first changes were logged: only a change that names it carries it, so older fingerprints still match.
  if (rest.noticeCategories !== undefined) named.push(['noticeCategories', rest.noticeCategories]);
  return createHash('sha256').update(JSON.stringify(named)).digest('hex');
}

function checkReading(definition: StatusDefinition, reading: StatusReading, at: Date): void {
  if (!definition.components.some((c) => c.id === reading.componentId)) throw new StatusPageError('status.component_unknown');
  if (reading.observedAt.getTime() > at.getTime() + STATUS_READING_SKEW_MS) throw new StatusPageError('status.reading_in_future');
}

const sameReading = (a: StatusReading, b: StatusReading): boolean => a.state === b.state && a.source === b.source;

export class MemoryStatusPageBook implements StatusPageBook {
  private state: StatusDefinition = blank();
  private readonly byKey = new Map<string, string>();
  private readonly rows: StatusReading[] = [];
  readonly log: { key: string; by: string; reason: string; at: string }[] = [];

  async definition(): Promise<StatusDefinition> {
    return this.state;
  }

  async configure(change: StatusPageChange): Promise<StatusDefinition> {
    const key = statusPageConfigureKey(change.input.expectedRevision);
    const fingerprint = statusFingerprint(change.input);
    if (change.input.expectedRevision !== this.state.revision) {
      if (this.byKey.get(key) === fingerprint) return this.state;
      throw new StatusPageError('status.page_revision_stale');
    }
    const next = applyStatusChange(this.state, change.input);
    if (sameValues(this.state, next)) return this.state;
    this.state = { ...next, revision: this.state.revision + 1, updatedAt: change.at };
    this.byKey.set(key, fingerprint);
    this.log.push({ key, by: change.by, reason: change.input.reason, at: change.at });
    return this.state;
  }

  async record(reading: StatusReading, _by: string, at: Date): Promise<StatusReading> {
    checkReading(this.state, reading, at);
    const existing = this.rows.find(
      (row) => row.componentId === reading.componentId && row.observedAt.getTime() === reading.observedAt.getTime(),
    );
    if (existing) {
      if (!sameReading(existing, reading)) throw new StatusPageError('status.reading_conflict');
      return existing;
    }
    this.rows.push(reading);
    return reading;
  }

  async latest(): Promise<readonly StatusReading[]> {
    const newest = new Map<string, StatusReading>();
    for (const row of this.rows) {
      const seen = newest.get(row.componentId);
      if (!seen || row.observedAt.getTime() > seen.observedAt.getTime()) newest.set(row.componentId, row);
    }
    return [...newest.values()];
  }

  async daily(since: Date): Promise<readonly StatusDay[]> {
    const days = new Map<string, StatusDay & { states: StatusReadingState[] }>();
    for (const row of this.rows) {
      if (row.observedAt.getTime() < since.getTime()) continue;
      const date = row.observedAt.toISOString().slice(0, 10);
      const key = `${row.componentId} ${date}`;
      const day = days.get(key) ?? { componentId: row.componentId, date, states: [] };
      if (!day.states.includes(row.state)) day.states.push(row.state);
      days.set(key, day);
    }
    return [...days.values()];
  }
}

type PageRow = {
  components: StatusComponentDefinition[];
  component_cap: number | null;
  staleness_seconds: number | null;
  uptime_days: number | null;
  challenge_bits: number | null;
  subscribe_rate_per_hour: number | null;
  notice_categories: NoticeCategory[] | null;
  revision: number;
  updated_at: Date | string | null;
};

type ReadingRow = { component_id: string; state: StatusReadingState; observed_at: Date; source: string };

const fromPage = (row: PageRow | undefined): StatusDefinition =>
  row
    ? {
        components: row.components,
        componentCap: row.component_cap,
        stalenessSeconds: row.staleness_seconds,
        uptimeDays: row.uptime_days,
        challengeBits: row.challenge_bits,
        subscribeRatePerHour: row.subscribe_rate_per_hour,
        noticeCategories: row.notice_categories ?? null,
        revision: row.revision,
        updatedAt: row.updated_at === null ? null : new Date(row.updated_at).toISOString(),
      }
    : blank();

const fromReading = (row: ReadingRow): StatusReading => ({
  componentId: row.component_id,
  state: row.state,
  observedAt: new Date(row.observed_at),
  source: row.source,
});

export class SqlStatusPageBook implements StatusPageBook {
  constructor(private readonly sql: Sql) {}

  async definition(): Promise<StatusDefinition> {
    const rows = await this.sql<PageRow[]>`
      SELECT components, component_cap, staleness_seconds, uptime_days, challenge_bits, subscribe_rate_per_hour, notice_categories,
             revision, updated_at FROM notify.status_page
    `;
    return fromPage(rows[0]);
  }

  async configure(change: StatusPageChange): Promise<StatusDefinition> {
    const key = statusPageConfigureKey(change.input.expectedRevision);
    const fingerprint = statusFingerprint(change.input);
    return this.sql.begin(async (tx) => {
      // The single row is the lock: every writer serialises on it.
      await tx`INSERT INTO notify.status_page (singleton) VALUES (true) ON CONFLICT DO NOTHING`;
      const [locked] = await tx<PageRow[]>`
        SELECT components, component_cap, staleness_seconds, uptime_days, challenge_bits, subscribe_rate_per_hour, notice_categories,
               revision, updated_at
        FROM notify.status_page WHERE singleton FOR UPDATE
      `;
      const prior = fromPage(locked);
      if (change.input.expectedRevision !== prior.revision) {
        const [logged] = await tx<{ fingerprint: string }[]>`SELECT fingerprint FROM notify.status_page_log WHERE key = ${key}`;
        if (logged?.fingerprint === fingerprint) return prior;
        throw new StatusPageError('status.page_revision_stale');
      }
      const next = applyStatusChange(prior, change.input);
      if (sameValues(prior, next)) return prior;
      const after: StatusDefinition = { ...next, revision: prior.revision + 1, updatedAt: change.at };
      await tx`
        UPDATE notify.status_page
        SET components = ${tx.json(after.components as never)}, component_cap = ${after.componentCap},
            staleness_seconds = ${after.stalenessSeconds}, uptime_days = ${after.uptimeDays},
            challenge_bits = ${after.challengeBits}, subscribe_rate_per_hour = ${after.subscribeRatePerHour},
            notice_categories = ${after.noticeCategories === null ? null : tx.json(after.noticeCategories as never)}, revision = ${after.revision},
            updated_by = ${change.by}, updated_at = ${change.at}
        WHERE singleton
      `;
      await tx`
        INSERT INTO notify.status_page_log (key, fingerprint, revision_after, before, after, set_by, reason, set_at)
        VALUES (${key}, ${fingerprint}, ${after.revision}, ${tx.json(prior as never)}, ${tx.json(after as never)},
                ${change.by}, ${change.input.reason}, ${change.at})
      `;
      return after;
    }) as Promise<StatusDefinition>;
  }

  async record(reading: StatusReading, by: string, at: Date): Promise<StatusReading> {
    checkReading(await this.definition(), reading, at);
    const inserted = await this.sql<ReadingRow[]>`
      INSERT INTO notify.status_readings (component_id, observed_at, state, source, recorded_by, recorded_at)
      VALUES (${reading.componentId}, ${reading.observedAt}, ${reading.state}, ${reading.source}, ${by}, ${at})
      ON CONFLICT (component_id, observed_at) DO NOTHING
      RETURNING component_id, state, observed_at, source
    `;
    if (inserted[0]) return fromReading(inserted[0]);
    const [existing] = await this.sql<ReadingRow[]>`
      SELECT component_id, state, observed_at, source FROM notify.status_readings
      WHERE component_id = ${reading.componentId} AND observed_at = ${reading.observedAt}
    `;
    if (!existing || !sameReading(fromReading(existing), reading)) throw new StatusPageError('status.reading_conflict');
    return fromReading(existing);
  }

  async latest(): Promise<readonly StatusReading[]> {
    const rows = await this.sql<ReadingRow[]>`
      SELECT DISTINCT ON (component_id) component_id, state, observed_at, source
      FROM notify.status_readings ORDER BY component_id, observed_at DESC
    `;
    return rows.map(fromReading);
  }

  async daily(since: Date): Promise<readonly StatusDay[]> {
    const rows = await this.sql<{ component_id: string; day: string; states: StatusReadingState[] }[]>`
      SELECT component_id, to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, array_agg(DISTINCT state) AS states
      FROM notify.status_readings WHERE observed_at >= ${since}
      GROUP BY 1, 2
    `;
    return rows.map((row) => ({ componentId: row.component_id, date: row.day, states: row.states }));
  }
}

/**
 * SP-csat-02: satisfaction survey configuration. Configure names the revision it read: a new survey is revision 0, a
 * stale revision is refused, and the same config replayed under the same revision returns the stored survey. The
 * configured survey becomes the one active survey; any other is deactivated. The survey cap is a blank owner value:
 * `list` reports it `unset` with `support.survey_cap_unset`, and a new survey past the first refuses with that code; a set cap
 * refuses a new survey at the cap with `support.survey_cap_reached`. Editing an existing survey is never capped.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import {
  SUPPORT_SURVEY_CAP_REACHED,
  SUPPORT_SURVEY_CAP_UNSET,
  SUPPORT_SURVEY_ID_CONFLICT,
  SUPPORT_SURVEY_NOT_FOUND,
  SUPPORT_SURVEY_REVISION_STALE,
  type SupportSurvey,
  type SupportSurveyConfig,
  type SupportSurveyConfigureInput,
  type SupportSurveyList,
} from '@intafaced/contracts';

export class SurveyStaleError extends Error {
  readonly code = SUPPORT_SURVEY_REVISION_STALE;
  constructor() {
    super(SUPPORT_SURVEY_REVISION_STALE);
    this.name = 'SurveyStaleError';
  }
}
export class SurveyNotFoundError extends Error {
  readonly code = SUPPORT_SURVEY_NOT_FOUND;
  constructor() {
    super(SUPPORT_SURVEY_NOT_FOUND);
    this.name = 'SurveyNotFoundError';
  }
}

/** A client-chosen new survey id already holds a different configuration. */
export class SurveyIdConflictError extends Error {
  readonly code = SUPPORT_SURVEY_ID_CONFLICT;
  constructor() {
    super(SUPPORT_SURVEY_ID_CONFLICT);
    this.name = 'SurveyIdConflictError';
  }
}

/** A new survey is refused: the cap is blank (and one survey already exists) or the cap is reached. */
export class SurveyCapError extends Error {
  constructor(readonly code: typeof SUPPORT_SURVEY_CAP_UNSET | typeof SUPPORT_SURVEY_CAP_REACHED) {
    super(code);
    this.name = 'SurveyCapError';
  }
}

/** The owner cap on how many surveys exist. Blank (null) allows only the first survey ("a blank cap: a second survey refuses"). */
export function checkSurveyCap(cap: number | null, existing: number): void {
  if (cap === null) {
    if (existing >= 1) throw new SurveyCapError(SUPPORT_SURVEY_CAP_UNSET);
  } else if (existing >= cap) throw new SurveyCapError(SUPPORT_SURVEY_CAP_REACHED);
}

export interface SurveyConfigure extends SupportSurveyConfigureInput {
  readonly by: string;
  readonly at: string;
  /** The founder who approved this configure (consumed identity action approval). */
  readonly approvedBy?: string | null;
}

/** One audit row per configure: who, why, and who approved. */
export interface SurveyLogEntry {
  readonly key: string;
  readonly surveyId: string;
  readonly revisionAfter: number;
  readonly setBy: string;
  readonly reason: string;
  readonly approvedBy: string | null;
  readonly approvalId: string | null;
}

export interface SurveyBook {
  list(): Promise<SupportSurveyList>;
  configure(input: SurveyConfigure): Promise<SupportSurvey>;
}

export const surveyKey = (surveyId: string, revision: number) => `support.survey:${surveyId}:r${revision}`;
/** Key-order independent: jsonb does not keep the order the config was written in. */
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
        )
      : v;
const same = (a: SupportSurveyConfig, b: SupportSurveyConfig) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const capOf = (cap: number | null) =>
  cap === null ? ({ status: 'unset', code: SUPPORT_SURVEY_CAP_UNSET } as const) : ({ status: 'set', cap } as const);

export class MemorySurveyBook implements SurveyBook {
  private readonly surveys = new Map<string, SupportSurvey>();
  /** key -> config written under it, so a lost reply replays. */
  private readonly byKey = new Map<string, SupportSurveyConfig>();
  /** Append-only audit, as `support.survey_log`. */
  readonly log: SurveyLogEntry[] = [];
  constructor(
    private readonly newId: () => string = randomUUID,
    private readonly cap: number | null = null,
  ) {}

  async list(): Promise<SupportSurveyList> {
    return { cap: capOf(this.cap), surveys: [...this.surveys.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)) };
  }

  async configure(input: SurveyConfigure): Promise<SupportSurvey> {
    if (input.surveyId === null && input.newSurveyId !== undefined) {
      const taken = this.surveys.get(input.newSurveyId);
      if (taken) {
        if (same(this.byKey.get(surveyKey(taken.surveyId, 1)) ?? ({} as never), input.config)) return taken;
        throw new SurveyIdConflictError();
      }
    }
    const prior = input.surveyId === null ? undefined : this.surveys.get(input.surveyId);
    if (input.surveyId !== null && !prior) throw new SurveyNotFoundError();
    const currentRevision = prior?.revision ?? 0;
    if (input.expectedRevision !== currentRevision) {
      if (prior && same(this.byKey.get(surveyKey(prior.surveyId, input.expectedRevision + 1)) ?? ({} as never), input.config)) return prior;
      throw new SurveyStaleError();
    }
    if (!prior) checkSurveyCap(this.cap, this.surveys.size);
    const surveyId = prior?.surveyId ?? input.newSurveyId ?? this.newId();
    const next: SupportSurvey = { surveyId, revision: currentRevision + 1, active: true, config: input.config, updatedAt: input.at };
    for (const [id, s] of this.surveys) if (id !== surveyId && s.active) this.surveys.set(id, { ...s, active: false });
    this.surveys.set(surveyId, next);
    this.byKey.set(surveyKey(surveyId, next.revision), input.config);
    this.log.push({
      key: surveyKey(surveyId, next.revision),
      surveyId,
      revisionAfter: next.revision,
      setBy: input.by,
      reason: input.reason,
      approvedBy: input.approvedBy ?? null,
      approvalId: input.approvalId ?? null,
    });
    return next;
  }
}

type Row = { survey_id: string; revision: number; active: boolean; config: SupportSurveyConfig; updated_at: Date | string };
const fromRow = (r: Row): SupportSurvey => ({
  surveyId: r.survey_id,
  revision: r.revision,
  active: r.active,
  config: r.config,
  updatedAt: new Date(r.updated_at).toISOString(),
});

export class SqlSurveyBook implements SurveyBook {
  constructor(
    private readonly sql: Sql,
    private readonly newId: () => string = randomUUID,
    private readonly cap: number | null = null,
  ) {}

  async list(): Promise<SupportSurveyList> {
    const rows = await this.sql<
      Row[]
    >`SELECT survey_id, revision, active, config, updated_at FROM support.surveys ORDER BY updated_at, survey_id`;
    return { cap: capOf(this.cap), surveys: rows.map(fromRow) };
  }

  async configure(input: SurveyConfigure): Promise<SupportSurvey> {
    return this.sql.begin(async (tx) => {
      // Serialise every configure: one active survey is decided under this lock.
      await tx`SELECT pg_advisory_xact_lock(hashtext('svc-support'), hashtext('surveys'))`;
      if (input.surveyId === null && input.newSurveyId !== undefined) {
        // Replay of a create under the client's id: the revision-1 log row is what that create wrote.
        const [taken] = await tx<Row[]>`
          SELECT survey_id, revision, active, config, updated_at FROM support.surveys WHERE survey_id = ${input.newSurveyId}`;
        if (taken) {
          const [logged] = await tx<{ config: SupportSurveyConfig }[]>`
            SELECT config FROM support.survey_log WHERE key = ${surveyKey(input.newSurveyId, 1)}`;
          if (logged && same(logged.config, input.config)) return fromRow(taken);
          throw new SurveyIdConflictError();
        }
      }
      let prior: SupportSurvey | undefined;
      if (input.surveyId !== null) {
        const [row] = await tx<
          Row[]
        >`SELECT survey_id, revision, active, config, updated_at FROM support.surveys WHERE survey_id = ${input.surveyId}`;
        if (!row) throw new SurveyNotFoundError();
        prior = fromRow(row);
      }
      const currentRevision = prior?.revision ?? 0;
      if (input.expectedRevision !== currentRevision) {
        if (prior) {
          const [logged] = await tx<{ config: SupportSurveyConfig }[]>`
            SELECT config FROM support.survey_log WHERE key = ${surveyKey(prior.surveyId, input.expectedRevision + 1)}`;
          if (logged && same(logged.config, input.config)) return prior;
        }
        throw new SurveyStaleError();
      }
      if (!prior) {
        const [row] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM support.surveys`;
        checkSurveyCap(this.cap, row?.n ?? 0);
      }
      const surveyId = prior?.surveyId ?? input.newSurveyId ?? this.newId();
      const revision = currentRevision + 1;
      await tx`UPDATE support.surveys SET active = false WHERE active AND survey_id <> ${surveyId}`;
      await tx`
        INSERT INTO support.surveys (survey_id, revision, active, config, updated_by, updated_at)
        VALUES (${surveyId}, ${revision}, true, ${tx.json(input.config as never)}, ${input.by}, ${input.at})
        ON CONFLICT (survey_id) DO UPDATE SET revision = EXCLUDED.revision, active = true, config = EXCLUDED.config,
          updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`;
      await tx`
        INSERT INTO support.survey_log (key, survey_id, revision_after, config, set_by, reason, approved_by, approval_id, set_at)
        VALUES (${surveyKey(surveyId, revision)}, ${surveyId}, ${revision}, ${tx.json(input.config as never)}, ${input.by}, ${input.reason},
          ${input.approvedBy ?? null}, ${input.approvalId ?? null}, ${input.at})`;
      return { surveyId, revision, active: true, config: input.config, updatedAt: new Date(input.at).toISOString() };
    }) as Promise<SupportSurvey>;
  }
}

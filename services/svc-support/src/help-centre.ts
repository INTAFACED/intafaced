/**
 * Help centre settings (SP-help-centre-03).
 *
 * The publish switch, the name, the address, the default language, the offered languages and the setup mode are each
 * null until the owner sets them. A read never turns a blank switch into on or off. Asking for a language while none
 * are offered refuses `support.languages_unset`. A translation the owner has not recorded reads as missing; the gap
 * is not stored until someone records it.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import {
  SUPPORT_HELP_CENTRE_LIST_LIMIT_MAX,
  SUPPORT_HELP_CENTRE_SETTING_INVALID,
  SUPPORT_LANGUAGES_UNSET,
  SUPPORT_HELP_CENTRE_LIST_LIMIT_UNSET,
  SUPPORT_HELP_CENTRE_REVISION_STALE,
  SUPPORT_HELP_CENTRE_IDEMPOTENCY_CONFLICT,
  kbAudienceVisibleTo,
  supportHelpCentreAddressProblem,
  supportHelpCentreSchema,
  supportHelpCentreSetKey,
  supportHelpCentreTranslationKey,
  type SupportHelpCentre,
  type SupportHelpCentreLanguage,
  type SupportHelpCentreSetInput,
  type SupportHelpCentreTranslation,
  type SupportHelpCentreTranslationList,
  type SupportHelpCentreTranslationState,
  type SupportKbAudience,
  type SupportKbViewer,
} from '@intafaced/contracts';
import { PLATFORM_KB_SPINE } from './kb-catalog.js';

export class HelpCentreStaleError extends Error {
  constructor() {
    super(SUPPORT_HELP_CENTRE_REVISION_STALE);
    this.name = 'HelpCentreStaleError';
  }
}

export class HelpCentreInvalidError extends Error {
  constructor() {
    super(SUPPORT_HELP_CENTRE_SETTING_INVALID);
    this.name = 'HelpCentreInvalidError';
  }
}

export class HelpCentreLanguagesUnsetError extends Error {
  constructor() {
    super(SUPPORT_LANGUAGES_UNSET);
    this.name = 'HelpCentreLanguagesUnsetError';
  }
}

export class HelpCentreLimitUnsetError extends Error {
  constructor() {
    super(SUPPORT_HELP_CENTRE_LIST_LIMIT_UNSET);
    this.name = 'HelpCentreLimitUnsetError';
  }
}

export class HelpCentreConflictError extends Error {
  constructor() {
    super(SUPPORT_HELP_CENTRE_IDEMPOTENCY_CONFLICT);
    this.name = 'HelpCentreConflictError';
  }
}

export class HelpCentreNotFoundError extends Error {
  constructor() {
    super('support.not_found');
    this.name = 'HelpCentreNotFoundError';
  }
}

type Values = Pick<SupportHelpCentre, 'name' | 'address' | 'defaultLanguage' | 'languages' | 'setupMode' | 'published'>;

const FIELDS = ['name', 'address', 'defaultLanguage', 'languages', 'setupMode', 'published'] as const;

export interface HelpCentreChange {
  readonly changes: Partial<Values>;
  readonly expectedRevision: number;
  readonly by: string;
  readonly reason: string;
  readonly at: string;
}

export interface HelpCentreTranslationChange {
  readonly articleId: string;
  readonly version: number;
  readonly language: string;
  readonly state: SupportHelpCentreTranslationState;
  readonly clientRequestId: string;
  readonly by: string;
  readonly reason: string;
  readonly at: string;
}

const blank = (): SupportHelpCentre => ({
  name: null,
  address: null,
  defaultLanguage: null,
  languages: null,
  setupMode: null,
  published: null,
  revision: 0,
  updatedAt: null,
});

/** The trimmed changes of an operator call, with fields left out staying `undefined`. */
export function helpCentreChangesOf(input: SupportHelpCentreSetInput): Partial<Values> {
  const out: { -readonly [K in keyof Values]?: Values[K] } = {};
  if (input.name !== undefined) out.name = input.name;
  if (input.address !== undefined) out.address = input.address;
  if (input.defaultLanguage !== undefined) out.defaultLanguage = input.defaultLanguage;
  if (input.languages !== undefined) out.languages = input.languages === null ? null : [...input.languages];
  if (input.setupMode !== undefined) out.setupMode = input.setupMode;
  if (input.published !== undefined) out.published = input.published;
  return out;
}

function applyChanges(prior: SupportHelpCentre, changes: Partial<Values>): Values {
  return {
    name: changes.name === undefined ? prior.name : changes.name,
    address: changes.address === undefined ? prior.address : changes.address,
    defaultLanguage: changes.defaultLanguage === undefined ? prior.defaultLanguage : changes.defaultLanguage,
    languages: changes.languages === undefined ? prior.languages : changes.languages,
    setupMode: changes.setupMode === undefined ? prior.setupMode : changes.setupMode,
    published: changes.published === undefined ? prior.published : changes.published,
  };
}

const sameList = (a: readonly string[] | null, b: readonly string[] | null): boolean => {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
};

const sameValues = (a: Values, b: Values): boolean =>
  a.name === b.name &&
  a.address === b.address &&
  a.defaultLanguage === b.defaultLanguage &&
  sameList(a.languages, b.languages) &&
  a.setupMode === b.setupMode &&
  a.published === b.published;

/** The https href of an address the contract accepts. Anything else is the typed refusal, before a write. */
export function canonicalHelpCentreAddress(value: string): string {
  if (supportHelpCentreAddressProblem(value) !== null) throw new HelpCentreInvalidError();
  const href = new URL(value.trim()).href;
  if (supportHelpCentreAddressProblem(href) !== null) throw new HelpCentreInvalidError();
  return href;
}

function normalizeChanges(changes: Partial<Values>): Partial<Values> {
  if (changes.address === undefined || changes.address === null) return changes;
  const address = canonicalHelpCentreAddress(changes.address);
  return address === changes.address ? changes : { ...changes, address };
}

const anonymousViewer: SupportKbViewer = { signedIn: false, staff: false };

/** Same audience rule as getKbArticle. An unknown audience is hidden, not public. */
function audienceVisible(audience: string | null | undefined, viewer: SupportKbViewer): boolean {
  if (audience === undefined || audience === null || audience === 'public') return kbAudienceVisibleTo(undefined, viewer);
  if (audience === 'signed_in' || audience === 'staff') return kbAudienceVisibleTo(audience, viewer);
  return false;
}

function isAddressCheckViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const pg = err as { code?: string; constraint_name?: string; message?: string };
  if (pg.code !== '23514') return false;
  return pg.constraint_name === 'help_centre_address_ck' || (pg.message?.includes('help_centre_address_ck') ?? false);
}

/** A set default must be one of the offered languages. An unset list does not invent a default, and the reverse is allowed. */
export function helpCentreCombinationProblem(values: Values): string | null {
  if (values.defaultLanguage !== null && values.languages !== null && !values.languages.includes(values.defaultLanguage)) {
    return 'default_not_offered';
  }
  return null;
}

/** What identifies one change: the fields it sets, in a fixed order, and the reason. The actor and the time are not part of it. */
export function helpCentreFingerprint(changes: Partial<Values>, reason: string): string {
  const parts = FIELDS.map((field) => (changes[field] === undefined ? null : [field, changes[field]]));
  return createHash('sha256')
    .update(JSON.stringify([parts, reason]))
    .digest('hex');
}

type VersionRef = {
  readonly articleId: string;
  readonly version: number;
  readonly audience?: SupportKbAudience;
  /** When this row is the head, whether the article is published. */
  readonly published: boolean;
};

export interface HelpCentreLanguageRead {
  readonly language: string;
  readonly articleId?: string;
  readonly version?: number;
  /** From the signed principal. Left out, the reader is a signed-out visitor. */
  readonly viewer?: SupportKbViewer;
}

export interface HelpCentreBook {
  get(): Promise<SupportHelpCentre>;
  set(change: HelpCentreChange): Promise<SupportHelpCentre>;
  language(input: HelpCentreLanguageRead): Promise<SupportHelpCentreLanguage>;
  setTranslation(change: HelpCentreTranslationChange): Promise<SupportHelpCentreTranslation>;
  listTranslations(limit: number | undefined): Promise<SupportHelpCentreTranslationList>;
}

type SettingsLogRow = {
  key: string;
  before: SupportHelpCentre;
  after: SupportHelpCentre;
  by: string;
  reason: string;
  at: string;
};

const spineVersions = (): VersionRef[] =>
  PLATFORM_KB_SPINE.map((article) => ({
    articleId: article.id,
    version: article.version ?? 1,
    audience: article.audience,
    published: article.published !== false,
  }));

export class MemoryHelpCentreBook implements HelpCentreBook {
  private state: SupportHelpCentre = blank();
  private readonly byKey = new Map<string, { fingerprint: string; after: SupportHelpCentre }>();
  private readonly versions: VersionRef[] = spineVersions();
  private readonly translations = new Map<string, SupportHelpCentreTranslationState>();
  private readonly receipts = new Map<string, SupportHelpCentreTranslationState>();
  readonly log: SettingsLogRow[] = [];
  readonly translationLog: {
    key: string;
    articleId: string;
    version: number;
    language: string;
    state: SupportHelpCentreTranslationState;
  }[] = [];

  async get(): Promise<SupportHelpCentre> {
    return this.state;
  }

  async set(change: HelpCentreChange): Promise<SupportHelpCentre> {
    const normalized = { ...change, changes: normalizeChanges(change.changes) };
    const key = supportHelpCentreSetKey(normalized.expectedRevision);
    const fingerprint = helpCentreFingerprint(normalized.changes, normalized.reason);
    if (normalized.expectedRevision !== this.state.revision) {
      const logged = this.byKey.get(key);
      if (logged?.fingerprint === fingerprint) return logged.after;
      throw new HelpCentreStaleError();
    }
    const next = applyChanges(this.state, normalized.changes);
    if (helpCentreCombinationProblem(next) !== null) throw new HelpCentreInvalidError();
    if (sameValues(this.state, next)) return this.state;
    const after: SupportHelpCentre = { ...next, revision: this.state.revision + 1, updatedAt: normalized.at };
    this.log.push({ key, before: this.state, after, by: normalized.by, reason: normalized.reason, at: normalized.at });
    this.byKey.set(key, { fingerprint, after });
    this.state = after;
    return after;
  }

  async language(input: HelpCentreLanguageRead): Promise<SupportHelpCentreLanguage> {
    if (this.state.languages === null) throw new HelpCentreLanguagesUnsetError();
    if (!this.state.languages.includes(input.language)) throw new HelpCentreInvalidError();
    const translation = await this.translationOf(input.articleId, input.version, input.language, input.viewer ?? anonymousViewer);
    return {
      language: input.language,
      defaultLanguage: this.state.defaultLanguage,
      languages: [...this.state.languages],
      published: this.state.published,
      setupMode: this.state.setupMode,
      name: this.state.name,
      address: this.state.address,
      translation,
    };
  }

  async setTranslation(change: HelpCentreTranslationChange): Promise<SupportHelpCentreTranslation> {
    const key = supportHelpCentreTranslationKey(change);
    const stored = this.receipts.get(key);
    if (stored !== undefined) return translationReplay(change, stored);
    this.requireOffered(change.language);
    if (!this.versions.some((row) => row.articleId === change.articleId && row.version === change.version)) {
      throw new HelpCentreNotFoundError();
    }
    this.translations.set(translationMapKey(change), change.state);
    this.receipts.set(key, change.state);
    this.translationLog.push({
      key,
      articleId: change.articleId,
      version: change.version,
      language: change.language,
      state: change.state,
    });
    return { articleId: change.articleId, version: change.version, language: change.language, state: change.state };
  }

  async listTranslations(limit: number | undefined): Promise<SupportHelpCentreTranslationList> {
    assertLimit(limit);
    if (this.state.languages === null) return { languages: null, total: null, rows: [] };
    const languages = this.state.languages;
    const rows: SupportHelpCentreTranslation[] = [];
    const versions = [...this.versions].sort((a, b) => a.articleId.localeCompare(b.articleId) || a.version - b.version);
    for (const version of versions) {
      for (const language of languages) {
        const state = this.translations.get(`${version.articleId}:${version.version}:${language}`) ?? 'missing';
        rows.push({ articleId: version.articleId, version: version.version, language, state });
      }
    }
    return { languages: [...languages], total: rows.length, rows: rows.slice(0, limit) };
  }

  private requireOffered(language: string): void {
    if (this.state.languages === null) throw new HelpCentreLanguagesUnsetError();
    if (!this.state.languages.includes(language)) throw new HelpCentreInvalidError();
  }

  /**
   * Published head, then that head's audience, then the named version. A hidden article and a missing id
   * both refuse, and the article id is not returned.
   */
  private versionVisible(articleId: string, version: number, viewer: SupportKbViewer): boolean {
    const history = this.versions.filter((row) => row.articleId === articleId).sort((a, b) => a.version - b.version);
    const head = history[history.length - 1];
    if (!head || !head.published || !audienceVisible(head.audience, viewer)) return false;
    const hit = history.find((row) => row.version === version);
    return Boolean(hit && audienceVisible(hit.audience, viewer));
  }

  private async translationOf(
    articleId: string | undefined,
    version: number | undefined,
    language: string,
    viewer: SupportKbViewer,
  ): Promise<SupportHelpCentreLanguage['translation']> {
    if (articleId === undefined || version === undefined) return null;
    if (!this.versionVisible(articleId, version, viewer)) throw new HelpCentreNotFoundError();
    const state = this.translations.get(`${articleId}:${version}:${language}`) ?? 'missing';
    return { articleId, version, state };
  }
}

/** A request id seen before answers what it first recorded; the same id asking for another state is a conflict. */
function translationReplay(change: HelpCentreTranslationChange, stored: SupportHelpCentreTranslationState): SupportHelpCentreTranslation {
  if (stored !== change.state) throw new HelpCentreConflictError();
  return { articleId: change.articleId, version: change.version, language: change.language, state: stored };
}

function translationMapKey(input: { articleId: string; version: number; language: string }): string {
  return `${input.articleId}:${input.version}:${input.language}`;
}

function assertLimit(limit: number | undefined): asserts limit is number {
  if (limit === undefined) throw new HelpCentreLimitUnsetError();
  if (!Number.isInteger(limit) || limit < 1 || limit > SUPPORT_HELP_CENTRE_LIST_LIMIT_MAX) throw new HelpCentreInvalidError();
}

type SettingsRow = {
  name: string | null;
  address: string | null;
  default_language: string | null;
  languages: string[] | null;
  setup_mode: 'setup' | 'live' | null;
  published: boolean | null;
  revision: number;
  updated_at: Date | string | null;
};

const fromRow = (row: SettingsRow | undefined): SupportHelpCentre =>
  row
    ? {
        name: row.name,
        address: row.address,
        defaultLanguage: row.default_language,
        languages: row.languages,
        setupMode: row.setup_mode,
        published: row.published,
        revision: row.revision,
        updatedAt: row.updated_at === null ? null : new Date(row.updated_at).toISOString(),
      }
    : blank();

export class SqlHelpCentreBook implements HelpCentreBook {
  constructor(private readonly sql: Sql) {}

  async get(): Promise<SupportHelpCentre> {
    const rows = await this.sql<SettingsRow[]>`
      SELECT name, address, default_language, languages, setup_mode, published, revision, updated_at
      FROM support.help_centre
    `;
    return fromRow(rows[0]);
  }

  async set(change: HelpCentreChange): Promise<SupportHelpCentre> {
    const normalized = { ...change, changes: normalizeChanges(change.changes) };
    const key = supportHelpCentreSetKey(normalized.expectedRevision);
    const fingerprint = helpCentreFingerprint(normalized.changes, normalized.reason);
    try {
      return (await this.sql.begin(async (tx) => {
        await tx`INSERT INTO support.help_centre (singleton) VALUES (true) ON CONFLICT DO NOTHING`;
        const [locked] = await tx<SettingsRow[]>`
          SELECT name, address, default_language, languages, setup_mode, published, revision, updated_at
          FROM support.help_centre WHERE singleton FOR UPDATE
        `;
        const prior = fromRow(locked);
        if (normalized.expectedRevision !== prior.revision) {
          const [logged] = await tx<{ fingerprint: string; after: SupportHelpCentre }[]>`
            SELECT fingerprint, after FROM support.help_centre_log WHERE key = ${key}
          `;
          if (logged?.fingerprint === fingerprint) return supportHelpCentreSchema.parse(logged.after);
          throw new HelpCentreStaleError();
        }
        const next = applyChanges(prior, normalized.changes);
        if (helpCentreCombinationProblem(next) !== null) throw new HelpCentreInvalidError();
        if (sameValues(prior, next)) return prior;
        const after: SupportHelpCentre = { ...next, revision: prior.revision + 1, updatedAt: normalized.at };
        await tx`
          UPDATE support.help_centre
          SET name = ${after.name}, address = ${after.address}, default_language = ${after.defaultLanguage},
              languages = ${after.languages}, setup_mode = ${after.setupMode}, published = ${after.published},
              revision = ${after.revision}, updated_by = ${normalized.by}, updated_at = ${normalized.at}
          WHERE singleton
        `;
        await tx`
          INSERT INTO support.help_centre_log (key, fingerprint, revision_after, before, after, set_by, reason, set_at)
          VALUES (
            ${key}, ${fingerprint}, ${after.revision}, ${tx.json(prior as never)}, ${tx.json(after as never)},
            ${normalized.by}, ${normalized.reason}, ${normalized.at}
          )
        `;
        return after;
      })) as SupportHelpCentre;
    } catch (err) {
      if (isAddressCheckViolation(err)) throw new HelpCentreInvalidError();
      throw err;
    }
  }

  async language(input: HelpCentreLanguageRead): Promise<SupportHelpCentreLanguage> {
    const settings = await this.get();
    if (settings.languages === null) throw new HelpCentreLanguagesUnsetError();
    if (!settings.languages.includes(input.language)) throw new HelpCentreInvalidError();
    const viewer = input.viewer ?? anonymousViewer;
    let translation: SupportHelpCentreLanguage['translation'] = null;
    if (input.articleId !== undefined && input.version !== undefined) {
      // Published head first, then that head's audience, then the named version. Hidden and missing are one refusal.
      const [visible] = await this.sql<{ head_audience: string | null; version_audience: string | null }[]>`
        SELECT head.audience AS head_audience, v.audience AS version_audience
        FROM support.kb_articles a
        JOIN support.kb_article_versions head ON head.id = a.id AND head.version = a.revision
        JOIN support.kb_article_versions v ON v.id = a.id AND v.version = ${input.version} AND NOT v.draft
        WHERE a.id = ${input.articleId} AND a.published = true
      `;
      if (!visible || !audienceVisible(visible.head_audience, viewer) || !audienceVisible(visible.version_audience, viewer)) {
        throw new HelpCentreNotFoundError();
      }
      const [row] = await this.sql<{ state: SupportHelpCentreTranslationState }[]>`
        SELECT state FROM support.help_centre_translation
        WHERE article_id = ${input.articleId} AND version = ${input.version} AND language = ${input.language}
      `;
      translation = { articleId: input.articleId, version: input.version, state: row?.state ?? 'missing' };
    }
    return {
      language: input.language,
      defaultLanguage: settings.defaultLanguage,
      languages: [...settings.languages],
      published: settings.published,
      setupMode: settings.setupMode,
      name: settings.name,
      address: settings.address,
      translation,
    };
  }

  async setTranslation(change: HelpCentreTranslationChange): Promise<SupportHelpCentreTranslation> {
    const key = supportHelpCentreTranslationKey(change);
    return this.sql.begin(async (tx) => {
      // The receipt first: a committed write answers its retry even if the offered languages changed since.
      const [receipt] = await tx<{ state: SupportHelpCentreTranslationState }[]>`
        SELECT state FROM support.help_centre_translation_log WHERE key = ${key}
      `;
      if (receipt) return translationReplay(change, receipt.state);
      // Share-lock the settings row so a language list cleared in the same moment cannot be written past.
      const [settings] = await tx<{ languages: string[] | null }[]>`
        SELECT languages FROM support.help_centre WHERE singleton FOR SHARE
      `;
      if (!settings || settings.languages === null) throw new HelpCentreLanguagesUnsetError();
      if (!settings.languages.includes(change.language)) throw new HelpCentreInvalidError();
      await tx`SELECT pg_advisory_xact_lock(hashtext(${change.articleId}), ${change.version})`;
      const [version] = await tx<{ id: string }[]>`
        SELECT id FROM support.kb_article_versions
        WHERE id = ${change.articleId} AND version = ${change.version} AND NOT draft
        FOR SHARE
      `;
      if (!version) throw new HelpCentreNotFoundError();
      const [existing] = await tx<{ state: SupportHelpCentreTranslationState }[]>`
        SELECT state FROM support.help_centre_translation_log WHERE key = ${key}
      `;
      if (existing) return translationReplay(change, existing.state);
      await tx`
        INSERT INTO support.help_centre_translation (article_id, version, language, state, set_by, set_at)
        VALUES (${change.articleId}, ${change.version}, ${change.language}, ${change.state}, ${change.by}, ${change.at})
        ON CONFLICT (article_id, version, language)
        DO UPDATE SET state = EXCLUDED.state, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at
      `;
      await tx`
        INSERT INTO support.help_centre_translation_log (key, article_id, version, language, state, set_by, reason, set_at)
        VALUES (
          ${key}, ${change.articleId}, ${change.version}, ${change.language}, ${change.state},
          ${change.by}, ${change.reason}, ${change.at}
        )
      `;
      return { articleId: change.articleId, version: change.version, language: change.language, state: change.state };
    }) as Promise<SupportHelpCentreTranslation>;
  }

  async listTranslations(limit: number | undefined): Promise<SupportHelpCentreTranslationList> {
    assertLimit(limit);
    // One snapshot, so the languages, the total and the rows are read at the same moment.
    return this.sql.begin('isolation level repeatable read read only', async (tx) => {
      const [settingsRow] = await tx<SettingsRow[]>`
      SELECT name, address, default_language, languages, setup_mode, published, revision, updated_at
      FROM support.help_centre
    `;
      const settings = fromRow(settingsRow);
      if (settings.languages === null) return { languages: null, total: null, rows: [] };
      const languages = settings.languages;
      const tags = tx.array(languages);
      const [count] = await tx<{ total: number }[]>`
      SELECT count(*)::int AS total
      FROM support.kb_article_versions
      CROSS JOIN unnest(${tags}::text[]) AS lang(language)
      WHERE NOT draft
    `;
      const rows = await tx<{ article_id: string; version: number; language: string; state: SupportHelpCentreTranslationState }[]>`
      SELECT v.id AS article_id, v.version, l.language, COALESCE(t.state, 'missing') AS state
      FROM support.kb_article_versions v
      CROSS JOIN unnest(${tags}::text[]) WITH ORDINALITY AS l(language, ordinality)
      LEFT JOIN support.help_centre_translation t
        ON t.article_id = v.id AND t.version = v.version AND t.language = l.language
      WHERE NOT v.draft
      ORDER BY v.id, v.version, l.ordinality
      LIMIT ${limit}
    `;
      return {
        languages: [...languages],
        total: count?.total ?? 0,
        rows: rows.map((row) => ({ articleId: row.article_id, version: row.version, language: row.language, state: row.state })),
      };
    }) as Promise<SupportHelpCentreTranslationList>;
  }
}

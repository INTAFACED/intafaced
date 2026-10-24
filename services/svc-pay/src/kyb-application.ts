import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import {
  kybApplicationSectionDataSchema,
  type KybApplicationSection,
  type KybApplicationSectionData,
  type KybApplicationView,
  type KybEntityType,
  type KybEntityTypeRequirements,
} from '@intafaced/contracts';
import { KybError, type KybService } from './kyb-service.js';
import type { KybEntityTypeService } from './kyb-entity-types.js';

/**
 * THE BUSINESS VERIFICATION APPLICATION (I-kyc-compliance-21).
 *
 * One draft per merchant, saved a section at a time, then submitted. Which sections are required is fixed when the
 * application starts, from what the owner had published for the entity type (`kyb-entity-types.ts`). A save names the
 * version it read; a stale save is a conflict. Submit goes through `KybService.submit`, so the merchant's KYB status
 * moves in the same transaction as the application, and a submitted application is never edited again.
 *
 * Section answers are bounded named fields. This file holds no requirement and no field list: both are owner data.
 *
 * The documents section counts only the uploads made since the last restart or type change (`documents_after_seq`),
 * and it cannot be marked complete, nor the application submitted, while a required document has no upload or its
 * latest was rejected. How long a business has to finish is the owner's `PAY_KYB_APPLICATION_DUE_DAYS`; blank means
 * no due date, never a made-up one.
 */

export const KYB_APPLICATION_DUE_DAYS_ENV = 'PAY_KYB_APPLICATION_DUE_DAYS';

/** Days from the start of an application to its due date, or null while unpublished. A malformed value refuses to boot. */
export function readKybApplicationDueDays(env: Record<string, string | undefined>): number | null {
  const raw = env[KYB_APPLICATION_DUE_DAYS_ENV]?.trim() ?? '';
  if (!raw) return null;
  if (!/^[1-9][0-9]{0,2}$/.test(raw) || Number(raw) > 365) {
    throw new Error(`${KYB_APPLICATION_DUE_DAYS_ENV} must be a whole number of days from 1 to 365. Refusing to boot.`);
  }
  return Number(raw);
}

const ALL_SECTIONS = ['company_details', 'people', 'owners', 'documents', 'questionnaires'] as const;

/** Company details always; the other sections only when the type's published requirements call for them. */
export function requiredSectionsFor(
  req: Pick<KybEntityTypeRequirements, 'documentKeys' | 'peopleRoles' | 'questionnaireKeys'>,
): KybApplicationSection[] {
  const sections: KybApplicationSection[] = ['company_details'];
  if (req.peopleRoles.length > 0) sections.push('people');
  if (req.documentKeys.length > 0) sections.push('documents');
  if (req.questionnaireKeys.length > 0) sections.push('questionnaires');
  return sections;
}

interface ApplicationRow {
  id: string;
  merchant_id: string;
  entity_type: KybEntityType;
  country: string;
  required_sections: KybApplicationSection[];
  state: 'draft' | 'submitted';
  kyb_ref: string | null;
  submitted_at: Date | null;
  created_at: Date;
  documents_after_seq: string;
}

interface SectionRow {
  section: KybApplicationSection;
  version: number;
  complete: boolean;
  data: unknown;
  updated_at: Date;
}

const APPLICATION_COLUMNS = `id, merchant_id, entity_type, country, required_sections, state, kyb_ref, submitted_at, created_at, documents_after_seq`;
const DAY_MS = 86_400_000;

function sameData(a: KybApplicationSectionData, b: KybApplicationSectionData): boolean {
  const canon = (d: KybApplicationSectionData) => JSON.stringify(Object.entries(d).sort(([x], [y]) => (x < y ? -1 : 1)));
  return canon(a) === canon(b);
}

export class KybApplicationService {
  constructor(
    private readonly sql: Sql,
    private readonly kyb: Pick<KybService, 'submit'>,
    private readonly entityTypes: Pick<KybEntityTypeService, 'requirements'>,
    /** `readKybApplicationDueDays`: null while the owner publishes none. */
    private readonly dueDays: number | null = null,
  ) {}

  /** Which merchant an application belongs to, for the ownership check. Null when there is no such application. */
  async merchantOf(applicationId: string): Promise<string | null> {
    const [row] = await this.sql<Array<{ merchant_id: string }>>`SELECT merchant_id FROM pay.kyb_applications WHERE id = ${applicationId}`;
    return row?.merchant_id ?? null;
  }

  /**
   * Start the merchant's draft. Starting again with the same type and country returns the same draft. A different
   * type while a draft is open refuses (`pay.kyb_application_exists`); restart the draft to begin again.
   * Refuses when the type is not published or the country is not served, and when KYB is already pending or approved.
   */
  async start(input: { merchantId: string; entityType: KybEntityType; country: string; actorId: string }): Promise<KybApplicationView> {
    const requirements = await this.entityTypes.requirements(input.entityType, input.country);
    const required = requiredSectionsFor(requirements);
    return transaction(
      this.sql,
      async (tx) => {
        const [merchant] = await tx<Array<{ kyb_status: string }>>`
          SELECT kyb_status FROM pay.merchants WHERE id = ${input.merchantId} FOR UPDATE
        `;
        if (!merchant) throw new KybError(`No merchant ${input.merchantId}`, 'pay.merchant_not_found');
        const [open] = await tx<ApplicationRow[]>`
          SELECT ${tx.unsafe(APPLICATION_COLUMNS)} FROM pay.kyb_applications WHERE merchant_id = ${input.merchantId} AND state = 'draft'
        `;
        if (open) {
          if (open.entity_type !== input.entityType || open.country !== input.country) {
            throw new KybError('A business application is already open for another entity type or country', 'pay.kyb_application_exists', {
              entityType: open.entity_type,
              country: open.country,
            });
          }
          return this.view(tx, open);
        }
        if (merchant.kyb_status === 'pending' || merchant.kyb_status === 'approved') {
          throw new KybError(`Merchant KYB is already ${merchant.kyb_status}`, 'pay.kyb_invalid', { kybStatus: merchant.kyb_status });
        }
        const [created] = await tx<ApplicationRow[]>`
          INSERT INTO pay.kyb_applications (merchant_id, entity_type, country, required_sections)
          VALUES (${input.merchantId}, ${input.entityType}, ${input.country}, ${required})
          RETURNING ${tx.unsafe(APPLICATION_COLUMNS)}
        `;
        if (!created) throw new KybError('The application was not created', 'pay.kyb_application_not_written');
        await tx`
          INSERT INTO pay.kyb_application_events (application_id, kind, actor_id) VALUES (${created.id}, 'started', ${input.actorId})
        `;
        return this.view(tx, created);
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  /** The merchant's open draft, or its latest submitted application; null when it never started one. */
  async current(merchantId: string): Promise<KybApplicationView | null> {
    const [row] = await this.sql<ApplicationRow[]>`
      SELECT ${this.sql.unsafe(APPLICATION_COLUMNS)} FROM pay.kyb_applications
       WHERE merchant_id = ${merchantId}
       ORDER BY (state = 'draft') DESC, created_at DESC
       LIMIT 1
    `;
    return row ? this.view(this.sql, row) : null;
  }

  /**
   * Save one section. `expectedVersion` is the version the caller read (0 for an empty section). The same save sent
   * again after it landed returns the saved section unchanged; any other stale version is `pay.kyb_section_version_conflict`.
   */
  async saveSection(input: {
    applicationId: string;
    section: KybApplicationSection;
    expectedVersion: number;
    complete: boolean;
    data: KybApplicationSectionData;
    actorId: string;
  }): Promise<KybApplicationView> {
    const data = kybApplicationSectionDataSchema.parse(input.data);
    return transaction(
      this.sql,
      async (tx) => {
        const app = await this.lockDraft(tx, input.applicationId);
        if (!ALL_SECTIONS.includes(input.section)) throw new KybError(`Unknown section ${input.section}`, 'pay.kyb_invalid');
        const [existing] = await tx<SectionRow[]>`
          SELECT section, version, complete, data, updated_at FROM pay.kyb_application_sections
           WHERE application_id = ${input.applicationId} AND section = ${input.section} FOR UPDATE
        `;
        const current = existing?.version ?? 0;
        if (current === input.expectedVersion + 1 && existing && existing.complete === input.complete) {
          const stored = kybApplicationSectionDataSchema.parse(existing.data);
          if (sameData(stored, data)) return this.view(tx, app);
        }
        if (current !== input.expectedVersion) {
          throw new KybError(
            `${input.section} is at version ${current}, not ${input.expectedVersion}`,
            'pay.kyb_section_version_conflict',
            {
              section: input.section,
              version: current,
            },
          );
        }
        if (input.section === 'documents' && input.complete) {
          const absent = await this.missingDocuments(tx, app);
          if (absent.length > 0) {
            throw new KybError(`Documents are still needed: ${absent.join(', ')}`, 'pay.kyb_documents_missing', { missing: absent });
          }
        }
        const next = current + 1;
        await tx`
          INSERT INTO pay.kyb_application_sections (application_id, section, version, complete, data)
          VALUES (${input.applicationId}, ${input.section}, ${next}, ${input.complete}, ${tx.json(data as never)})
          ON CONFLICT (application_id, section)
          DO UPDATE SET version = EXCLUDED.version, complete = EXCLUDED.complete, data = EXCLUDED.data, updated_at = now()
        `;
        await tx`UPDATE pay.kyb_applications SET updated_at = now() WHERE id = ${input.applicationId}`;
        await tx`
          INSERT INTO pay.kyb_application_events (application_id, kind, section, version, actor_id)
          VALUES (${input.applicationId}, 'section_saved', ${input.section}, ${next}, ${input.actorId})
        `;
        return this.view(tx, app);
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  /** Clear every section of an open draft. The events of the earlier saves stay. */
  async restart(input: { applicationId: string; actorId: string }): Promise<KybApplicationView> {
    return transaction(
      this.sql,
      async (tx) => {
        await this.lockDraft(tx, input.applicationId);
        const cleared = await this.clear(tx, input.applicationId);
        await tx`
          INSERT INTO pay.kyb_application_events (application_id, kind, actor_id) VALUES (${input.applicationId}, 'restarted', ${input.actorId})
        `;
        return this.view(tx, cleared);
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  /**
   * Change the draft's entity type or country. Refuses an unpublished type or unserved country like `start`. Clears
   * every section, takes the required sections from the new type, and stops earlier uploads from counting, so what is
   * still needed is listed again from the start. The same type and country again change nothing.
   */
  async changeType(input: {
    applicationId: string;
    entityType: KybEntityType;
    country: string;
    actorId: string;
  }): Promise<KybApplicationView> {
    const requirements = await this.entityTypes.requirements(input.entityType, input.country);
    const required = requiredSectionsFor(requirements);
    return transaction(
      this.sql,
      async (tx) => {
        const app = await this.lockDraft(tx, input.applicationId);
        if (app.entity_type === input.entityType && app.country === input.country) return this.view(tx, app);
        await tx`
          UPDATE pay.kyb_applications SET entity_type = ${input.entityType}, country = ${input.country}, required_sections = ${required}
           WHERE id = ${input.applicationId}
        `;
        const changed = await this.clear(tx, input.applicationId);
        await tx`
          INSERT INTO pay.kyb_application_events (application_id, kind, actor_id, entity_type, country)
          VALUES (${input.applicationId}, 'type_changed', ${input.actorId}, ${input.entityType}, ${input.country})
        `;
        return this.view(tx, changed);
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  /** Delete the sections and move the document boundary past every upload so far. The caller holds the row lock. */
  private async clear(tx: Sql, applicationId: string): Promise<ApplicationRow> {
    await tx`DELETE FROM pay.kyb_application_sections WHERE application_id = ${applicationId}`;
    const [row] = await tx<ApplicationRow[]>`
      UPDATE pay.kyb_applications
         SET documents_after_seq = coalesce((SELECT max(seq) FROM pay.kyb_documents WHERE application_id = ${applicationId}), documents_after_seq),
             updated_at = now()
       WHERE id = ${applicationId}
       RETURNING ${tx.unsafe(APPLICATION_COLUMNS)}
    `;
    if (!row) throw new KybError('No such application', 'pay.kyb_application_not_found');
    return row;
  }

  /**
   * Submit. Refuses with `pay.kyb_incomplete` (naming the sections) until every required section is complete. Moves the
   * merchant's KYB to pending through `KybService.submit` in the same transaction; the dossier reference is the application id.
   */
  async submit(input: { applicationId: string; merchantId: string; actorId: string }): Promise<KybApplicationView> {
    const kybRef = `application:${input.applicationId}`;
    await this.kyb.submit({
      merchantId: input.merchantId,
      kybRef,
      actorId: input.actorId,
      actorScope: 'pay:write',
      reason: 'merchant submitted KYB application',
      beforeWrite: async (tx) => {
        const app = await this.lockDraft(tx, input.applicationId);
        if (app.merchant_id !== input.merchantId) throw new KybError('No such application', 'pay.kyb_application_not_found');
        const missing = await this.missing(tx, app);
        if (missing.length > 0) {
          throw new KybError(`Required sections are not complete: ${missing.join(', ')}`, 'pay.kyb_incomplete', { missing });
        }
        if (app.required_sections.includes('documents')) {
          const absent = await this.missingDocuments(tx, app);
          if (absent.length > 0) {
            throw new KybError(`Documents are still needed: ${absent.join(', ')}`, 'pay.kyb_documents_missing', { missing: absent });
          }
        }
        await tx`
          UPDATE pay.kyb_applications
             SET state = 'submitted', kyb_ref = ${kybRef}, submitted_at = now(), updated_at = now()
           WHERE id = ${input.applicationId}
        `;
        await tx`
          INSERT INTO pay.kyb_application_events (application_id, kind, actor_id) VALUES (${input.applicationId}, 'submitted', ${input.actorId})
        `;
      },
    });
    const [row] = await this.sql<
      ApplicationRow[]
    >`SELECT ${this.sql.unsafe(APPLICATION_COLUMNS)} FROM pay.kyb_applications WHERE id = ${input.applicationId}`;
    if (!row) throw new KybError('No such application', 'pay.kyb_application_not_found');
    return this.view(this.sql, row);
  }

  private async lockDraft(tx: Sql, applicationId: string): Promise<ApplicationRow> {
    const [app] = await tx<ApplicationRow[]>`
      SELECT ${tx.unsafe(APPLICATION_COLUMNS)} FROM pay.kyb_applications WHERE id = ${applicationId} FOR UPDATE
    `;
    if (!app) throw new KybError('No such application', 'pay.kyb_application_not_found');
    if (app.state !== 'draft') throw new KybError('The application is submitted and cannot be changed', 'pay.kyb_application_submitted');
    return app;
  }

  private async missing(q: Sql, app: ApplicationRow): Promise<KybApplicationSection[]> {
    const done = await q<Array<{ section: KybApplicationSection }>>`
      SELECT section FROM pay.kyb_application_sections WHERE application_id = ${app.id} AND complete
    `;
    const complete = new Set(done.map((r) => r.section));
    return ALL_SECTIONS.filter((s) => app.required_sections.includes(s) && !complete.has(s));
  }

  /**
   * The published document keys of the application's type that have no upload since the boundary, or whose latest
   * upload was rejected. Read in the caller's transaction. A type that is no longer published refuses.
   */
  private async missingDocuments(q: Sql, app: ApplicationRow): Promise<string[]> {
    const [type] = await q<Array<{ document_keys: string[] }>>`
      SELECT document_keys FROM pay.kyb_entity_types WHERE entity_type = ${app.entity_type}
    `;
    if (!type) {
      throw new KybError(`Requirements for ${app.entity_type} are not published.`, 'pay.kyb_requirements_unset', {
        entityType: app.entity_type,
      });
    }
    const latest = await q<Array<{ document_key: string; state: string }>>`
      SELECT DISTINCT ON (document_key) document_key, state FROM pay.kyb_documents
       WHERE application_id = ${app.id} AND seq > ${app.documents_after_seq}
       ORDER BY document_key, seq DESC
    `;
    const usable = new Set(latest.filter((d) => d.state !== 'rejected').map((d) => d.document_key));
    return type.document_keys.filter((key) => !usable.has(key));
  }

  private async view(q: Sql, app: ApplicationRow): Promise<KybApplicationView> {
    const rows = await q<SectionRow[]>`
      SELECT section, version, complete, data, updated_at FROM pay.kyb_application_sections WHERE application_id = ${app.id}
    `;
    const bySection = new Map(rows.map((r) => [r.section, r]));
    return {
      applicationId: app.id,
      merchantId: app.merchant_id,
      entityType: app.entity_type,
      country: app.country,
      state: app.state,
      sections: ALL_SECTIONS.map((section) => {
        const row = bySection.get(section);
        return {
          section,
          state: row ? (row.complete ? ('complete' as const) : ('draft' as const)) : ('empty' as const),
          version: row?.version ?? 0,
          required: app.required_sections.includes(section),
          data: row ? kybApplicationSectionDataSchema.parse(row.data) : {},
          updatedAt: row ? row.updated_at.toISOString() : null,
        };
      }),
      missing: await this.missing(q, app),
      kybRef: app.kyb_ref,
      submittedAt: app.submitted_at ? app.submitted_at.toISOString() : null,
      startedAt: app.created_at.toISOString(),
      dueAt: this.dueDays === null ? null : new Date(app.created_at.getTime() + this.dueDays * DAY_MS).toISOString(),
    };
  }
}

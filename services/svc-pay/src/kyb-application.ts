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
 */

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
}

interface SectionRow {
  section: KybApplicationSection;
  version: number;
  complete: boolean;
  data: unknown;
  updated_at: Date;
}

const APPLICATION_COLUMNS = `id, merchant_id, entity_type, country, required_sections, state, kyb_ref, submitted_at`;

function sameData(a: KybApplicationSectionData, b: KybApplicationSectionData): boolean {
  const canon = (d: KybApplicationSectionData) => JSON.stringify(Object.entries(d).sort(([x], [y]) => (x < y ? -1 : 1)));
  return canon(a) === canon(b);
}

export class KybApplicationService {
  constructor(
    private readonly sql: Sql,
    private readonly kyb: Pick<KybService, 'submit'>,
    private readonly entityTypes: Pick<KybEntityTypeService, 'requirements'>,
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
        const app = await this.lockDraft(tx, input.applicationId);
        await tx`DELETE FROM pay.kyb_application_sections WHERE application_id = ${input.applicationId}`;
        await tx`UPDATE pay.kyb_applications SET updated_at = now() WHERE id = ${input.applicationId}`;
        await tx`
          INSERT INTO pay.kyb_application_events (application_id, kind, actor_id) VALUES (${input.applicationId}, 'restarted', ${input.actorId})
        `;
        return this.view(tx, app);
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
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
    };
  }
}

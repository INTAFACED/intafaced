import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Sql } from 'postgres';
import { z } from 'zod';
import * as workflow from '@intafaced/contracts';
import { transaction } from '@intafaced/db';
import {
  crmActivitySchema,
  crmAssignmentInputSchema,
  crmContactSchema,
  crmListInputSchema,
  crmNextActionInputSchema,
  crmNoteInputSchema,
  crmOpportunitySchema,
  crmOpportunityPageSchema,
  crmOrganisationSchema,
  crmStageChangeInputSchema,
  crmStageFitsAudience,
  crmSubmissionSchema,
  crmTaskSchema,
  outreachCaptureInputSchema,
  outreachCaptureReceiptSchema,
  outreachContinuationInputSchema,
  outreachDraftSchema,
  outreachQuestionnaireInputSchema,
  type CrmActivity,
  type CrmAssignmentInput,
  type CrmListInput,
  type CrmNextActionInput,
  type CrmNoteInput,
  type CrmOpportunity,
  type CrmStageChangeInput,
  type OutreachCaptureInput,
  type OutreachContinuationInput,
  type OutreachQuestionnaireInput,
  type OutreachDraft,
} from '@intafaced/contracts';
import { nextReviewAt, OutreachError, outreachConfigSchema, type OutreachConfig } from './config.js';
import {
  OutreachPrivacy,
  privacyReadLock,
  withPrivacySnapshot,
  assertContactWritable,
  assertSubmissionWritable,
  assertRequestNotErased,
} from './privacy.js';
import type { ArchivePublisher } from './archive-publication.js';
import { createOutreachNotificationClient, type OutreachNotificationPort } from './notification-client.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : Number(a > b)))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fingerprint = (value: unknown) => hash(canonical(value));
function normalizeIds<
  T extends {
    requestId?: string;
    submissionId?: string;
    opportunityId?: string;
    ownerUserId?: string;
    id?: string;
    contactId?: string;
    campaignId?: string;
    sourceContactId?: string;
    targetContactId?: string;
    taskId?: string;
    subjectId?: string;
  },
>(input: T): T {
  for (const field of [
    'requestId',
    'submissionId',
    'opportunityId',
    'ownerUserId',
    'id',
    'contactId',
    'campaignId',
    'sourceContactId',
    'targetContactId',
    'taskId',
    'subjectId',
  ] as const) {
    const value = input[field];
    if (value !== undefined) input[field] = value.toLowerCase();
  }
  return input;
}
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
type SubmissionRow = { id: string; contact_id: string; capability_hash: string; expires_at: Date; revision: number; record: unknown };

/** One persistence boundary for intake and staff workflow. No public email lookup exists. */
export class OutreachCrm {
  readonly privacy: OutreachPrivacy;
  constructor(
    private readonly sql: Sql | null,
    private readonly configuration: unknown,
    private readonly now: () => Date = () => new Date(),
    notify: OutreachNotificationPort = createOutreachNotificationClient({}),
    archivePublisher?: ArchivePublisher,
  ) {
    this.privacy = new OutreachPrivacy(sql, configuration, notify, now, archivePublisher);
  }
  private configured(): { sql: Sql; config: OutreachConfig } {
    if (!this.sql) throw new OutreachError('ops.crm.storage_unconfigured');
    const parsed = outreachConfigSchema.safeParse(this.configuration);
    if (!parsed.success) throw new OutreachError('ops.crm.configuration_unverified');
    return { sql: this.sql, config: parsed.data };
  }
  private async write<T>(
    fn: (tx: Sql, config: OutreachConfig) => Promise<T>,
    isolation: 'read committed' | 'repeatable read' = 'read committed',
  ): Promise<T> {
    const { sql, config } = this.configured();
    try {
      if (isolation === 'repeatable read') return await withPrivacySnapshot(sql, (tx) => fn(tx, config));
      return await transaction(
        sql,
        async (tx) => {
          await privacyReadLock(tx);
          return fn(tx, config);
        },
        { isolation },
      );
    } catch (error) {
      if (error instanceof OutreachError || (error instanceof Error && error.name === 'ZodError')) throw error;
      throw new OutreachError('ops.crm.storage_unavailable');
    }
  }
  private async publicRate(abuseKey: string): Promise<void> {
    const attempts = await this.write(async (tx) => this.rate(tx, abuseKey));
    if (attempts > 30) throw new OutreachError('ops.crm.rate_limited');
  }
  private async rate(tx: Sql, abuseKey: string): Promise<number> {
    if (!abuseKey) throw new OutreachError('ops.crm.abuse_context_unavailable');
    const key = hash(abuseKey);
    const window = new Date(Math.floor(this.now().getTime() / 60000) * 60000);
    const rows = await tx`INSERT INTO ops.crm_rate_windows(key_hash,window_start,attempts) VALUES (${key},${window},1)
      ON CONFLICT(key_hash,window_start) DO UPDATE SET attempts=ops.crm_rate_windows.attempts+1 RETURNING attempts`;
    return Number(rows[0]?.attempts);
  }
  private async lockRequest(tx: Sql, id: string, prospect = false): Promise<void> {
    await tx`SELECT pg_advisory_xact_lock(hashtext('ops.crm.request:' || ${id}))`;
    await assertRequestNotErased(tx, id, prospect);
    if ((await tx`SELECT 1 FROM ops.crm_privacy_requests WHERE request_id=${id}`).length)
      throw new OutreachError('ops.crm.idempotency_conflict');
  }
  private async replay(tx: Sql, requestId: string, actor: string, operation: string, input: unknown): Promise<unknown | null> {
    const rows = await tx`SELECT actor_key,operation,fingerprint,result FROM ops.crm_requests WHERE request_id=${requestId}`;
    const row = rows[0];
    if (!row) return null;
    if (row.actor_key !== actor || row.operation !== operation || row.fingerprint !== fingerprint(input))
      throw new OutreachError('ops.crm.idempotency_conflict');
    return row.result;
  }
  private async remember(
    tx: Sql,
    requestId: string,
    actor: string,
    operation: string,
    input: unknown,
    result: unknown,
    submissionId: string | null,
  ): Promise<void> {
    await tx`INSERT INTO ops.crm_requests(request_id,actor_key,operation,fingerprint,result,submission_id)
      VALUES (${requestId},${actor},${operation},${fingerprint(input)},${tx.json(JSON.parse(JSON.stringify(result)))},${submissionId})`;
  }
  private async authenticate(tx: Sql, input: OutreachContinuationInput): Promise<SubmissionRow> {
    await assertSubmissionWritable(tx, input.submissionId);
    const rows = await tx<SubmissionRow[]>`SELECT * FROM ops.crm_submissions WHERE id=${input.submissionId} FOR UPDATE`;
    const row = rows[0];
    if (!row || !sameHash(row.capability_hash, hash(input.continuationToken)) || new Date(row.expires_at).getTime() <= this.now().getTime())
      throw new OutreachError('ops.crm.continuation_invalid');
    return row;
  }
  private draft(row: SubmissionRow): OutreachDraft {
    const { contactId: _contactId, ...submission } = crmSubmissionSchema.parse(row.record);
    return outreachDraftSchema.parse({ ...submission, continuationExpiresAt: new Date(row.expires_at).toISOString() });
  }
  async capture(raw: OutreachCaptureInput, abuseKey: string) {
    const input = normalizeIds(outreachCaptureInputSchema.parse(raw));
    await this.publicRate(abuseKey);
    return this.write(async (tx, config) => {
      await this.lockRequest(tx, input.requestId, true);
      const previous = await tx`SELECT submission_id FROM ops.crm_requests WHERE request_id=${input.requestId}`;
      // Authenticate the capability BEFORE revealing/replaying the previous result.
      if (previous[0]) {
        await this.authenticate(tx, { submissionId: String(previous[0].submission_id), continuationToken: input.continuationToken });
        const replay = await this.replay(tx, input.requestId, 'prospect', 'capture', { ...input, continuationToken: undefined });
        return outreachCaptureReceipt(replay);
      }
      const submissionId = randomUUID(),
        contactId = randomUUID();
      const at = this.now().toISOString();
      const expires = new Date(this.now().getTime() + config.continuationTtlSeconds * 1000).toISOString();
      const organisationId = input.contact.organisationName ? randomUUID() : null;
      const contact = crmContactSchema.parse({
        id: contactId,
        name: input.contact.name,
        email: input.contact.email,
        emailEvidence: { status: 'unverified' },
        organisationIds: organisationId ? [organisationId] : [],
        interests: input.contact.interests,
        platformIdentity: null,
        createdAt: at,
        updatedAt: at,
      });
      await tx`INSERT INTO ops.crm_contacts(id,record) VALUES (${contactId},${tx.json(contact)})`;
      if (organisationId) {
        const org = crmOrganisationSchema.parse({
          id: organisationId,
          name: input.contact.organisationName,
          website: null,
          countries: input.contact.country ? [input.contact.country] : [],
          createdAt: at,
        });
        await tx`INSERT INTO ops.crm_organisations(id,record) VALUES (${organisationId},${tx.json(org)})`;
        await tx`INSERT INTO ops.crm_contact_organisations(contact_id,organisation_id) VALUES (${contactId},${organisationId})`;
      }
      const submission = crmSubmissionSchema.parse({
        submissionId,
        contactId,
        revision: 1,
        contact: input.contact,
        questionnaires: [],
        capturedAt: at,
        completedAt: null,
      });
      // Resolve only an operator-configured campaign mapping; recipient linkage stays unknown.
      const attribution = await this.captureAttribution(tx, input.sourceKey, at);
      await tx`INSERT INTO ops.crm_submissions(id,contact_id,capability_hash,expires_at,revision,record,original_contact,attribution)
        VALUES (${submissionId},${contactId},${hash(input.continuationToken)},${expires},1,${tx.json(submission)},${tx.json(input.contact)},${this.json(tx, attribution)})`;
      const dueAt = nextReviewAt(this.now(), config);
      for (const audience of input.contact.interests) {
        const opportunity = crmOpportunitySchema.parse({
          id: randomUUID(),
          contactId,
          organisationId,
          submissionId,
          audience,
          stage: 'new',
          ownerUserId: config.initialOwnerUserId,
          revision: 1,
          nextAction: { description: 'Review enquiry', dueAt },
          closedDisposition: null,
          closingEvidenceRef: null,
          createdAt: at,
          updatedAt: at,
          ...(audience === 'investor' ? { indicativeContribution: { status: 'undecided' } } : {}),
        });
        await tx`INSERT INTO ops.crm_opportunities(id,submission_id,contact_id,organisation_id,audience,stage,owner_user_id,revision,created_at,record)
          VALUES (${opportunity.id},${submissionId},${contactId},${organisationId},${audience},'new',${opportunity.ownerUserId},1,${at},${tx.json(opportunity)})`;
        await this.task(tx, opportunity);
        await this.activity(tx, opportunity.id, { kind: 'system', jobId: submissionId }, 'assigned', null, config.initialOwnerUserId);
      }
      await tx`INSERT INTO ops.crm_outbox(id,business_key,submission_id,kind,status,payload,created_at,updated_at,error_code)
        VALUES (${randomUUID()},${`acknowledgement:${submissionId}`},${submissionId},'enquiry_acknowledgement','unconfigured',${tx.json({ contactId, audiences: input.contact.interests, marketingPermission: input.contact.marketingOptIn })},${at},${at},'ops.crm.notification_unconfigured')`;
      const receipt = { submissionId, revision: 1, capturedAt: at, continuationExpiresAt: expires };
      await this.remember(tx, input.requestId, 'prospect', 'capture', { ...input, continuationToken: undefined }, receipt, submissionId);
      return receipt;
    });
  }
  async resume(raw: OutreachContinuationInput, abuseKey: string) {
    const input = normalizeIds(outreachContinuationInputSchema.parse(raw));
    await this.publicRate(abuseKey);
    return this.write(async (tx) => {
      return this.draft(await this.authenticate(tx, input));
    });
  }
  async answer(raw: OutreachQuestionnaireInput, abuseKey: string) {
    const input = normalizeIds(outreachQuestionnaireInputSchema.parse(raw));
    await this.publicRate(abuseKey);
    return this.write(async (tx) => {
      await this.lockRequest(tx, input.requestId, true);
      const row = await this.authenticate(tx, input);
      const businessInput = { ...input, continuationToken: undefined };
      const replay = await this.replay(tx, input.requestId, `prospect:${row.id}`, 'answer', businessInput);
      if (replay !== null) return outreachDraftSchema.parse(replay);
      const old = crmSubmissionSchema.parse(row.record);
      if (old.revision !== input.expectedRevision) throw new OutreachError('ops.crm.revision_conflict');
      if (!old.contact.interests.includes(input.questionnaire.audience)) throw new OutreachError('ops.crm.audience_not_selected');
      if (old.questionnaires.some((q) => q.audience === input.questionnaire.audience))
        throw new OutreachError('ops.crm.answers_already_preserved');
      const questionnaires = [...old.questionnaires, input.questionnaire];
      const updated = crmSubmissionSchema.parse({
        ...old,
        revision: old.revision + 1,
        questionnaires,
        completedAt: questionnaires.length === old.contact.interests.length ? this.now().toISOString() : null,
      });
      await tx`UPDATE ops.crm_submissions SET revision=${updated.revision},record=${tx.json(updated)},first_completed_at=COALESCE(first_completed_at,${updated.completedAt}::timestamptz) WHERE id=${row.id}`;
      const opportunities =
        await tx`SELECT record FROM ops.crm_opportunities WHERE submission_id=${row.id} AND audience=${input.questionnaire.audience} FOR UPDATE`;
      const opportunity = crmOpportunitySchema.parse(opportunities[0]?.record);
      if (input.questionnaire.audience === 'investor' && opportunity.audience === 'investor')
        await this.saveOpportunity(tx, {
          ...opportunity,
          indicativeContribution: input.questionnaire.answers.indicativeContribution,
          revision: opportunity.revision + 1,
          updatedAt: this.now().toISOString(),
        });
      await this.activity(tx, opportunity.id, { kind: 'prospect', submissionId: row.id }, 'questionnaire_submitted', null, input.requestId);
      const draft = this.draft({ ...row, record: updated });
      await this.remember(tx, input.requestId, `prospect:${row.id}`, 'answer', businessInput, draft, row.id);
      return draft;
    });
  }
  async addInterests(raw: workflow.OutreachAddInterestsInput, abuseKey: string) {
    const input = normalizeIds(workflow.outreachAddInterestsInputSchema.parse(raw));
    await this.publicRate(abuseKey);
    return this.write(async (tx, config) => {
      await this.lockRequest(tx, input.requestId, true);
      // Serialize canonical-link creation against founder merges, before row locks.
      await tx`SELECT pg_advisory_xact_lock(hashtext('ops.crm.contact-merges'))`;
      const row = await this.authenticate(tx, input);
      const businessInput = { ...input, continuationToken: undefined };
      const replay = await this.replay(tx, input.requestId, `prospect:${row.id}`, 'addInterests', businessInput);
      if (replay !== null) return outreachDraftSchema.parse(replay);
      const old = crmSubmissionSchema.parse(row.record);
      if (old.revision !== input.expectedRevision) throw new OutreachError('ops.crm.revision_conflict');
      const additions = input.interests.filter((interest) => !old.contact.interests.includes(interest));
      if (additions.length) {
        const aliases = await tx`SELECT canonical_contact_id FROM ops.crm_contact_aliases WHERE contact_id=${row.contact_id}`;
        const contactId = aliases[0] ? String(aliases[0].canonical_contact_id) : row.contact_id;
        const originals = await tx`SELECT record FROM ops.crm_contacts WHERE id=${row.contact_id}`;
        const organisationId = crmContactSchema.parse(originals[0]?.record).organisationIds[0] ?? null;
        const at = this.now().toISOString();
        for (const audience of additions) {
          const opportunity = crmOpportunitySchema.parse({
            id: randomUUID(),
            contactId,
            organisationId,
            submissionId: row.id,
            audience,
            stage: 'new',
            ownerUserId: config.initialOwnerUserId,
            revision: 1,
            nextAction: { description: 'Review enquiry', dueAt: nextReviewAt(this.now(), config) },
            closedDisposition: null,
            closingEvidenceRef: null,
            createdAt: at,
            updatedAt: at,
            ...(audience === 'investor' ? { indicativeContribution: { status: 'undecided' } } : {}),
          });
          await tx`INSERT INTO ops.crm_opportunities(id,submission_id,contact_id,organisation_id,audience,stage,owner_user_id,revision,created_at,record)
            VALUES (${opportunity.id},${row.id},${contactId},${organisationId},${audience},'new',${opportunity.ownerUserId},1,${at},${tx.json(opportunity)})`;
          await this.task(tx, opportunity);
          await this.activity(tx, opportunity.id, { kind: 'system', jobId: row.id }, 'assigned', null, config.initialOwnerUserId);
        }
        const updated = crmSubmissionSchema.parse({
          ...old,
          revision: old.revision + 1,
          contact: { ...old.contact, interests: [...old.contact.interests, ...additions] },
          completedAt: null,
        });
        await tx`UPDATE ops.crm_submissions SET revision=${updated.revision},record=${tx.json(updated)} WHERE id=${row.id}`;
        row.record = updated;
      }
      const draft = this.draft(row);
      await this.remember(tx, input.requestId, `prospect:${row.id}`, 'addInterests', businessInput, draft, row.id);
      return draft;
    });
  }
  owners() {
    const { config } = this.configured();
    return {
      ownerUserIds: [...config.founders],
      initialOwnerUserId: config.initialOwnerUserId,
      owners: [
        { userId: config.founders[0]!, displayName: 'Nitro' as const },
        { userId: config.founders[1]!, displayName: 'Phantom' as const },
      ] as [{ userId: string; displayName: 'Nitro' }, { userId: string; displayName: 'Phantom' }],
    };
  }
  async listOpportunities(raw: CrmListInput) {
    const input = normalizeIds(crmListInputSchema.parse(raw));
    return this.write(async (tx) => {
      let cursor: { at: string; id: string } | null = null;
      if (input.cursor) {
        try {
          cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')));
        } catch {
          throw new OutreachError('ops.crm.cursor_invalid');
        }
      }
      const rows = await tx`SELECT o.record,s.id AS submission_id,s.record->>'completedAt' AS completed_at,
        s.original_contact->>'organisationName' AS organisation_name
        FROM ops.crm_opportunities o JOIN ops.crm_contacts c ON c.id=o.contact_id
        JOIN ops.crm_submissions s ON s.id=o.submission_id
        WHERE (${input.audience ?? null}::text IS NULL OR o.audience=${input.audience ?? null})
        AND (${input.stage ?? null}::text IS NULL OR o.stage=${input.stage ?? null})
        AND (${input.ownerUserId ?? null}::uuid IS NULL OR o.owner_user_id=${input.ownerUserId ?? null}::uuid)
        AND (${input.query ?? null}::text IS NULL OR strpos(lower(c.record->>'name'),lower(${input.query ?? ''}))>0 OR strpos(lower(c.record->>'email'),lower(${input.query ?? ''}))>0
          OR EXISTS(SELECT 1 FROM ops.crm_contact_aliases al JOIN ops.crm_contacts ac ON ac.id=al.contact_id
            WHERE al.canonical_contact_id=o.contact_id
            AND NOT EXISTS(SELECT 1 FROM ops.crm_erasure_intents e WHERE ac.id = ANY(e.contact_ids))
            AND (strpos(lower(ac.record->>'name'),lower(${input.query ?? ''}))>0 OR strpos(lower(ac.record->>'email'),lower(${input.query ?? ''}))>0)))
        AND (${cursor?.at ?? null}::timestamptz IS NULL OR (o.created_at,o.id)<(${cursor?.at ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
        ORDER BY o.created_at DESC,o.id DESC LIMIT ${input.limit + 1}`;
      const items = rows.slice(0, input.limit).map((r) => crmOpportunitySchema.parse(r.record));
      const last = items.at(-1);
      const contactIds = [...new Set(items.map((item) => item.contactId))];
      const contactRows = contactIds.length
        ? await tx`SELECT record FROM ops.crm_contacts WHERE id = ANY(${tx.array(contactIds)}::uuid[])`
        : [];
      // Only when the visible (canonical) contact does not itself match: name the merged-away contact the search came through.
      const aliasRows =
        input.query && items.length
          ? await tx`SELECT DISTINCT ON (o.id) o.id AS opportunity_id,ac.record->>'name' AS name
            FROM ops.crm_opportunities o JOIN ops.crm_contacts c ON c.id=o.contact_id
            JOIN ops.crm_contact_aliases al ON al.canonical_contact_id=o.contact_id JOIN ops.crm_contacts ac ON ac.id=al.contact_id
            WHERE o.id = ANY(${tx.array(items.map((item) => item.id))}::uuid[])
            AND NOT (strpos(lower(c.record->>'name'),lower(${input.query}))>0 OR strpos(lower(c.record->>'email'),lower(${input.query}))>0)
            AND NOT EXISTS(SELECT 1 FROM ops.crm_erasure_intents e WHERE ac.id = ANY(e.contact_ids))
            AND (strpos(lower(ac.record->>'name'),lower(${input.query}))>0 OR strpos(lower(ac.record->>'email'),lower(${input.query}))>0)
            ORDER BY o.id,al.created_at,ac.id`
          : [];
      return crmOpportunityPageSchema.parse({
        ...(aliasRows.length ? { aliasMatches: aliasRows.map((row) => ({ opportunityId: row.opportunity_id, name: row.name })) } : {}),
        contacts: contactRows.map((row) => crmContactSchema.parse(row.record)),
        submissions: [
          ...new Map(
            rows.slice(0, input.limit).map((row) => [
              row.submission_id,
              {
                submissionId: row.submission_id,
                completedAt: row.completed_at,
                organisationName: row.organisation_name,
              },
            ]),
          ).values(),
        ],
        items,
        nextCursor:
          rows.length > input.limit && last ? Buffer.from(JSON.stringify({ at: last.createdAt, id: last.id })).toString('base64url') : null,
      });
    }, 'repeatable read');
  }
  async getOpportunity(input: { opportunityId: string }) {
    const opportunityId = uuidSchema.parse(input.opportunityId).toLowerCase();
    return this.write(async (tx) => {
      const rows = await tx`SELECT record FROM ops.crm_opportunities WHERE id=${opportunityId}`;
      if (!rows[0]) return null;
      const opportunity = crmOpportunitySchema.parse(rows[0].record);
      const deliveries =
        await tx`SELECT id,business_key,kind,status,attempts,acceptance_ref,error_code,created_at,updated_at FROM ops.crm_outbox WHERE submission_id=${opportunity.submissionId}`;
      const contacts = await tx`SELECT record FROM ops.crm_contacts WHERE id=${opportunity.contactId}`;
      const submissions = await tx`SELECT record FROM ops.crm_submissions WHERE id=${opportunity.submissionId}`;
      const organisations = opportunity.organisationId
        ? await tx`SELECT record FROM ops.crm_organisations WHERE id=${opportunity.organisationId}`
        : [];
      const activities = await tx`SELECT record FROM ops.crm_activities WHERE opportunity_id=${opportunityId} ORDER BY sequence`;
      const tasks = await tx`SELECT record FROM ops.crm_tasks WHERE opportunity_id=${opportunityId}`;
      return {
        opportunity,
        deliveries,
        contact: crmContactSchema.parse(contacts[0]?.record),
        submission: crmSubmissionSchema.parse(submissions[0]?.record),
        organisation: organisations[0] ? crmOrganisationSchema.parse(organisations[0].record) : null,
        activities: activities.map((r) => crmActivitySchema.parse(r.record)),
        tasks: tasks.map((r) => crmTaskSchema.parse(r.record)),
      };
    }, 'repeatable read');
  }
  private async mutate<T>(
    actorUserId: string,
    input: { requestId: string; opportunityId: string },
    operation: string,
    fn: (tx: Sql, opportunity: CrmOpportunity, config: OutreachConfig) => Promise<T>,
  ): Promise<T> {
    actorUserId = uuidSchema.parse(actorUserId).toLowerCase();
    return this.write(async (tx, config) => {
      if (!config.founders.includes(actorUserId)) throw new OutreachError('ops.crm.operator_forbidden');
      await this.lockRequest(tx, input.requestId);
      const current = await tx`SELECT contact_id FROM ops.crm_opportunities WHERE id=${input.opportunityId}`;
      if (current[0]) await assertContactWritable(tx, String(current[0].contact_id));
      const replay = await this.replay(tx, input.requestId, `operator:${actorUserId}`, operation, input);
      if (replay !== null) return replay as T;
      const rows = await tx`SELECT record FROM ops.crm_opportunities WHERE id=${input.opportunityId} FOR UPDATE`;
      if (!rows[0]) throw new OutreachError('ops.crm.opportunity_not_found');
      const opportunity = crmOpportunitySchema.parse(rows[0].record);
      const result = await fn(tx, opportunity, config);
      await this.remember(tx, input.requestId, `operator:${actorUserId}`, operation, input, result, opportunity.submissionId);
      return result;
    });
  }
  async assign(raw: CrmAssignmentInput, actorUserId: string) {
    actorUserId = uuidSchema.parse(actorUserId).toLowerCase();
    const input = normalizeIds(crmAssignmentInputSchema.parse(raw));
    input.ownerUserId = input.ownerUserId.toLowerCase();
    return this.mutate(actorUserId, input, 'assign', async (tx, old, config) => {
      if (old.revision !== input.expectedRevision) throw new OutreachError('ops.crm.revision_conflict');
      if (!config.founders.includes(input.ownerUserId)) throw new OutreachError('ops.crm.owner_not_founder');
      const row = await this.saveOpportunity(tx, {
        ...old,
        ownerUserId: input.ownerUserId,
        revision: old.revision + 1,
        updatedAt: this.now().toISOString(),
      });
      await this.task(tx, row, {
        actor: actorUserId,
        requestId: input.requestId,
        reason: 'Founder reassigned the opportunity',
      });
      await this.activity(tx, row.id, { kind: 'operator', userId: actorUserId }, 'assigned', null, input.ownerUserId);
      return row;
    });
  }
  async changeStage(raw: CrmStageChangeInput, actorUserId: string) {
    actorUserId = uuidSchema.parse(actorUserId).toLowerCase();
    const input = normalizeIds(crmStageChangeInputSchema.parse(raw));
    return this.mutate(actorUserId, input, 'changeStage', async (tx, old) => {
      if (old.revision !== input.expectedRevision) throw new OutreachError('ops.crm.revision_conflict');
      if (!crmStageFitsAudience(old.audience, input.stage)) throw new OutreachError('ops.crm.stage_invalid_for_audience');
      const row = await this.saveOpportunity(tx, {
        ...old,
        stage: input.stage,
        closedDisposition: input.closedDisposition,
        closingEvidenceRef: input.closingEvidenceRef,
        nextAction: input.nextAction,
        revision: old.revision + 1,
        updatedAt: this.now().toISOString(),
      });
      await this.task(tx, row, {
        actor: actorUserId,
        requestId: input.requestId,
        reason: input.reason,
      });
      await this.activity(tx, row.id, { kind: 'operator', userId: actorUserId }, 'stage_changed', input.reason, input.requestId);
      await this.audit(tx, actorUserId, input.requestId, 'opportunity', row.id, 'stage_changed', input.reason, {
        from: old.stage,
        to: row.stage,
        revision: row.revision,
        indicative: row.audience === 'investor' ? row.indicativeContribution : null,
      });
      return row;
    });
  }
  /** Edits the pending next action only: no stage change, no reason. Same lock, revision check, replay and audit as the other writes. */
  async updateNextAction(raw: CrmNextActionInput, actorUserId: string) {
    actorUserId = uuidSchema.parse(actorUserId).toLowerCase();
    const input = normalizeIds(crmNextActionInputSchema.parse(raw));
    // One instant has one spelling, so a retry that writes the same moment in another offset replays instead of conflicting.
    input.dueAt = new Date(input.dueAt).toISOString();
    return this.mutate(actorUserId, input, 'updateNextAction', async (tx, old) => {
      if (old.revision !== input.expectedRevision) throw new OutreachError('ops.crm.revision_conflict');
      if (old.stage === 'closed') throw new OutreachError('ops.crm.opportunity_closed');
      const dueAt = input.dueAt;
      const row = await this.saveOpportunity(tx, {
        ...old,
        nextAction: { description: input.description, dueAt },
        revision: old.revision + 1,
        updatedAt: this.now().toISOString(),
      });
      await this.task(tx, row, { actor: actorUserId, requestId: input.requestId, reason: 'Founder edited the next action' });
      // note = the new description, referenceId = the new due time, so the history can say what the next action became.
      await this.activity(tx, row.id, { kind: 'operator', userId: actorUserId }, 'next_action_changed', input.description, dueAt);
      return row;
    });
  }
  async addNote(raw: CrmNoteInput, actorUserId: string) {
    actorUserId = uuidSchema.parse(actorUserId).toLowerCase();
    const input = normalizeIds(crmNoteInputSchema.parse(raw));
    return this.mutate(actorUserId, input, 'addNote', (tx, row) =>
      this.activity(tx, row.id, { kind: 'operator', userId: actorUserId }, 'note', input.note, input.requestId),
    );
  }
  private json(tx: Sql, value: unknown) {
    return tx.json(JSON.parse(JSON.stringify(value)));
  }
  private async staffMutation<T>(
    actor: string,
    input: { requestId: string },
    operation: string,
    fn: (tx: Sql, config: OutreachConfig) => Promise<T>,
  ): Promise<T> {
    actor = uuidSchema.parse(actor).toLowerCase();
    return this.write(async (tx, config) => {
      if (!config.founders.includes(actor)) throw new OutreachError('ops.crm.operator_forbidden');
      await this.lockRequest(tx, input.requestId);
      if (operation === 'mergeContacts') {
        const merge = input as { requestId: string; sourceContactId: string; targetContactId: string };
        await assertContactWritable(tx, merge.sourceContactId);
        await assertContactWritable(tx, merge.targetContactId);
      }
      const replay = await this.replay(tx, input.requestId, `operator:${actor}`, operation, input);
      if (replay !== null) return replay as T;
      const result = await fn(tx, config);
      await this.remember(tx, input.requestId, `operator:${actor}`, operation, input, result, null);
      return result;
    });
  }
  private async audit(
    tx: Sql,
    actor: string,
    requestId: string,
    subjectType: z.infer<typeof workflow.crmWorkflowAuditSchema>['subjectType'],
    subjectId: string,
    kind: z.infer<typeof workflow.crmWorkflowAuditSchema>['kind'],
    reason: string,
    facts: Record<string, unknown>,
  ) {
    const row = workflow.crmWorkflowAuditSchema.parse({
      id: randomUUID(),
      requestId,
      actorUserId: actor.toLowerCase(),
      subjectType,
      subjectId,
      kind,
      reason,
      facts,
      occurredAt: this.now().toISOString(),
    });
    await tx`INSERT INTO ops.crm_workflow_audit(id,request_id,actor_user_id,subject_type,subject_id,kind,occurred_at,record)
      VALUES (${row.id},${requestId},${row.actorUserId},${subjectType},${subjectId},${kind},${row.occurredAt},${this.json(tx, row)})`;
    return row;
  }
  private pageCursor(raw: string | undefined, scope: string): { at: string; id: string } | null {
    if (!raw) return null;
    try {
      const value = cursorSchema
        .extend({ scope: z.string().length(64) })
        .strict()
        .parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
      if (value.scope !== fingerprint(scope)) throw new Error('scope');
      return { at: value.at, id: value.id.toLowerCase() };
    } catch {
      throw new OutreachError('ops.crm.cursor_invalid');
    }
  }
  private nextCursor(at: string, id: string, scope: string) {
    return Buffer.from(JSON.stringify({ at, id, scope: fingerprint(scope) })).toString('base64url');
  }
  private filterScope(input: Record<string, unknown>) {
    const { requestId: _request, cursor: _cursor, limit: _limit, ...filters } = input;
    return canonical(filters);
  }
  private attribution(raw: unknown, capturedAt: string) {
    const value = z
      .object({ sourceHint: z.string().nullable(), campaign: z.unknown().nullable(), recipientLinkage: z.literal('unknown') })
      .passthrough()
      .parse(raw);
    return workflow.crmAttributionSchema.parse({
      ...value,
      sourceMappingId: value.sourceMappingId ?? null,
      sourceMappingRevision: value.sourceMappingRevision ?? null,
      capturedAt: value.capturedAt ?? capturedAt,
    });
  }
  private async captureAttribution(tx: Sql, sourceKey: string | undefined, capturedAt: string) {
    const rows = sourceKey
      ? await tx`SELECT m.record AS mapping,c.record AS campaign FROM ops.crm_source_mappings m JOIN ops.crm_campaigns c ON c.id=m.campaign_id WHERE m.source_key=${sourceKey} AND m.status='active' FOR SHARE OF m,c`
      : [];
    const mapping = rows[0] ? workflow.crmSourceMappingSchema.parse(rows[0].mapping) : null;
    const campaign = rows[0] ? workflow.crmCampaignSchema.parse(rows[0].campaign) : null;
    const resolved = mapping && campaign?.status === 'active';
    return workflow.crmAttributionSchema.parse({
      sourceHint: sourceKey ?? null,
      sourceMappingId: resolved ? mapping.id : null,
      sourceMappingRevision: resolved ? mapping.revision : null,
      campaign: resolved
        ? {
            id: campaign.id,
            revision: campaign.revision,
            name: campaign.name,
            channel: campaign.channel,
            documentRef: campaign.documentRef,
            providerLinkId: campaign.providerLinkId,
          }
        : null,
      recipientLinkage: 'unknown',
      capturedAt,
    });
  }
  async upsertCampaign(raw: z.infer<typeof workflow.crmCampaignWriteInputSchema>, actor: string) {
    const input = normalizeIds(workflow.crmCampaignWriteInputSchema.parse(raw));
    return this.staffMutation(actor, input, 'upsertCampaign', async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('ops.crm.campaign:' || ${input.id}))`;
      const found = await tx`SELECT record FROM ops.crm_campaigns WHERE id=${input.id} FOR UPDATE`;
      const old = found[0] ? workflow.crmCampaignSchema.parse(found[0].record) : null;
      if ((old?.revision ?? 0) !== input.expectedRevision) throw new OutreachError('ops.crm.revision_conflict');
      const at = this.now().toISOString();
      const row = workflow.crmCampaignSchema.parse({
        id: input.id,
        revision: (old?.revision ?? 0) + 1,
        name: input.name,
        channel: input.channel,
        status: input.status,
        documentRef: input.documentRef,
        providerLinkId: input.providerLinkId,
        createdAt: old?.createdAt ?? at,
        updatedAt: at,
      });
      await tx`INSERT INTO ops.crm_campaigns(id,revision,created_at,record) VALUES (${row.id},${row.revision},${row.createdAt},${this.json(tx, row)}) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,record=excluded.record`;
      await this.audit(tx, actor, input.requestId, 'campaign', row.id, 'campaign_written', input.reason, { previous: old, current: row });
      return row;
    });
  }
  async upsertSourceMapping(raw: z.infer<typeof workflow.crmSourceMappingWriteInputSchema>, actor: string) {
    const input = normalizeIds(workflow.crmSourceMappingWriteInputSchema.parse(raw));
    return this.staffMutation(actor, input, 'upsertSourceMapping', async (tx) => {
      // Serialize both the unique public hint and staff mapping identity.
      await tx`SELECT pg_advisory_xact_lock(hashtext('ops.crm.source-mapping-writes'))`;
      const campaign = await tx`SELECT id FROM ops.crm_campaigns WHERE id=${input.campaignId} FOR SHARE`;
      if (!campaign[0]) throw new OutreachError('ops.crm.campaign_not_found');
      const found = await tx`SELECT record FROM ops.crm_source_mappings WHERE id=${input.id} FOR UPDATE`;
      const old = found[0] ? workflow.crmSourceMappingSchema.parse(found[0].record) : null;
      if ((old?.revision ?? 0) !== input.expectedRevision) throw new OutreachError('ops.crm.revision_conflict');
      if (old && old.sourceKey !== input.sourceKey) throw new OutreachError('ops.crm.source_key_immutable');
      const collision = await tx`SELECT id FROM ops.crm_source_mappings WHERE source_key=${input.sourceKey} AND id<>${input.id}`;
      if (collision[0]) throw new OutreachError('ops.crm.source_key_conflict');
      const at = this.now().toISOString();
      const row = workflow.crmSourceMappingSchema.parse({
        id: input.id,
        revision: (old?.revision ?? 0) + 1,
        sourceKey: input.sourceKey,
        campaignId: input.campaignId,
        status: input.status,
        createdAt: old?.createdAt ?? at,
        updatedAt: at,
      });
      await tx`INSERT INTO ops.crm_source_mappings(id,source_key,campaign_id,revision,status,created_at,record) VALUES (${row.id},${row.sourceKey},${row.campaignId},${row.revision},${row.status},${row.createdAt},${this.json(tx, row)}) ON CONFLICT(id) DO UPDATE SET campaign_id=excluded.campaign_id,revision=excluded.revision,status=excluded.status,record=excluded.record`;
      await this.audit(tx, actor, input.requestId, 'source_mapping', row.id, 'source_mapping_written', input.reason, {
        previous: old,
        current: row,
      });
      return row;
    });
  }
  async listCampaigns(raw: z.infer<typeof workflow.crmCampaignListInputSchema>) {
    const input = workflow.crmCampaignListInputSchema.parse(raw),
      scope = 'campaigns',
      cursor = this.pageCursor(input.cursor, scope);
    return this.write(async (tx) => {
      const rows =
        await tx`SELECT record FROM ops.crm_campaigns WHERE (${cursor?.at ?? null}::timestamptz IS NULL OR (created_at,id)<(${cursor?.at ?? null}::timestamptz,${cursor?.id ?? null}::uuid)) ORDER BY created_at DESC,id DESC LIMIT ${input.limit + 1}`;
      const items = rows.slice(0, input.limit).map((r) => workflow.crmCampaignSchema.parse(r.record)),
        last = items.at(-1);
      return workflow.crmCampaignPageSchema.parse({
        items,
        nextCursor: rows.length > input.limit && last ? this.nextCursor(last.createdAt, last.id, scope) : null,
      });
    }, 'repeatable read');
  }
  async listSourceMappings(raw: z.infer<typeof workflow.crmSourceMappingListInputSchema>) {
    const input = normalizeIds(workflow.crmSourceMappingListInputSchema.parse(raw)),
      scope = 'source-mappings:' + this.filterScope(input),
      cursor = this.pageCursor(input.cursor, scope);
    return this.write(async (tx) => {
      const rows =
        await tx`SELECT record FROM ops.crm_source_mappings WHERE (${input.campaignId ?? null}::uuid IS NULL OR campaign_id=${input.campaignId ?? null}::uuid) AND (${input.status ?? null}::text IS NULL OR status=${input.status ?? null}) AND (${cursor?.at ?? null}::timestamptz IS NULL OR (created_at,id)<(${cursor?.at ?? null}::timestamptz,${cursor?.id ?? null}::uuid)) ORDER BY created_at DESC,id DESC LIMIT ${input.limit + 1}`;
      const items = rows.slice(0, input.limit).map((r) => workflow.crmSourceMappingSchema.parse(r.record)),
        last = items.at(-1);
      return workflow.crmSourceMappingPageSchema.parse({
        items,
        nextCursor: rows.length > input.limit && last ? this.nextCursor(last.createdAt, last.id, scope) : null,
      });
    }, 'repeatable read');
  }
  async getContactProvenance(raw: z.infer<typeof workflow.crmContactProvenanceInputSchema>) {
    const input = normalizeIds(workflow.crmContactProvenanceInputSchema.parse(raw));
    return this.write(async (tx) => {
      const original = await tx`SELECT record,revision FROM ops.crm_contacts WHERE id=${input.contactId}`;
      if (!original[0]) return null;
      const aliases = await tx`SELECT canonical_contact_id FROM ops.crm_contact_aliases WHERE contact_id=${input.contactId}`;
      const canonicalId = aliases[0] ? String(aliases[0].canonical_contact_id) : input.contactId;
      const canonicalRows = await tx`SELECT record,revision FROM ops.crm_contacts WHERE id=${canonicalId}`;
      const sourceFilter = tx`SELECT attribution,record->>'capturedAt' AS captured_at,id FROM ops.crm_submissions WHERE (contact_id=${canonicalId} OR contact_id IN (SELECT contact_id FROM ops.crm_contact_aliases WHERE canonical_contact_id=${canonicalId})) AND attribution->'campaign' IS NOT NULL AND attribution->'campaign'<>'null'::jsonb`;
      const firstRows = await tx`SELECT * FROM (${sourceFilter}) s ORDER BY captured_at::timestamptz,id LIMIT 1`;
      const lastRows = await tx`SELECT * FROM (${sourceFilter}) s ORDER BY captured_at::timestamptz DESC,id DESC LIMIT 1`;
      const first = firstRows[0],
        last = lastRows[0];
      return workflow.crmContactProvenanceSchema.parse({
        originalContact: crmContactSchema.parse(original[0].record),
        canonicalContact: crmContactSchema.parse(canonicalRows[0]?.record),
        originalRevision: original[0].revision,
        canonicalRevision: canonicalRows[0]?.revision,
        firstKnownSource: first ? this.attribution(first.attribution, String(first.captured_at)) : null,
        latestKnownSource: last ? this.attribution(last.attribution, String(last.captured_at)) : null,
      });
    }, 'repeatable read');
  }
  async exportSubmissions(raw: z.infer<typeof workflow.crmExportInputSchema>, actor: string) {
    const input = normalizeIds(workflow.crmExportInputSchema.parse(raw)),
      scope = 'export:' + this.filterScope(input),
      cursor = this.pageCursor(input.cursor, scope);
    return this.staffMutation(actor, input, 'exportSubmissions', async (tx) => {
      const rows =
        await tx`SELECT s.record,s.original_contact AS initial_contact,s.first_completed_at,s.attribution,c.record AS original_contact,k.record AS canonical_contact FROM ops.crm_submissions s JOIN ops.crm_contacts c ON c.id=s.contact_id LEFT JOIN ops.crm_contact_aliases a ON a.contact_id=c.id JOIN ops.crm_contacts k ON k.id=COALESCE(a.canonical_contact_id,c.id)
        WHERE (${input.campaignId ?? null}::uuid IS NULL OR (s.attribution->'campaign'->>'id')::uuid=${input.campaignId ?? null}::uuid)
        AND (${input.sourceKey ?? null}::text IS NULL OR s.attribution->>'sourceHint'=${input.sourceKey ?? null})
        AND (${input.capturedFrom ?? null}::timestamptz IS NULL OR (s.record->>'capturedAt')::timestamptz>=${input.capturedFrom ?? null}::timestamptz)
        AND (${input.capturedBefore ?? null}::timestamptz IS NULL OR (s.record->>'capturedAt')::timestamptz<${input.capturedBefore ?? null}::timestamptz)
        AND EXISTS(SELECT 1 FROM ops.crm_opportunities o WHERE o.submission_id=s.id AND (${input.audience ?? null}::text IS NULL OR o.audience=${input.audience ?? null}) AND (${input.stage ?? null}::text IS NULL OR o.stage=${input.stage ?? null}) AND (${input.ownerUserId ?? null}::uuid IS NULL OR o.owner_user_id=${input.ownerUserId ?? null}::uuid))
        AND (${cursor?.at ?? null}::timestamptz IS NULL OR ((s.record->>'capturedAt')::timestamptz,s.id)<(${cursor?.at ?? null}::timestamptz,${cursor?.id ?? null}::uuid)) ORDER BY (s.record->>'capturedAt')::timestamptz DESC,s.id DESC LIMIT ${input.limit + 1}`;
      const items = rows.slice(0, input.limit).map((r) => {
          const submission = crmSubmissionSchema.parse(r.record);
          return {
            submission,
            initialContact: r.initial_contact,
            firstCompletedAt: r.first_completed_at ? new Date(r.first_completed_at).toISOString() : null,
            originalContact: crmContactSchema.parse(r.original_contact),
            canonicalContact: crmContactSchema.parse(r.canonical_contact),
            attribution: this.attribution(r.attribution, submission.capturedAt),
          };
        }),
        last = items.at(-1);
      const page = workflow.crmExportPageSchema.parse({
        exportId: randomUUID(),
        generatedAt: this.now().toISOString(),
        items,
        nextCursor:
          rows.length > input.limit && last ? this.nextCursor(last.submission.capturedAt, last.submission.submissionId, scope) : null,
      });
      await this.audit(
        tx,
        actor,
        input.requestId,
        'export',
        page.exportId,
        'export_generated',
        'Founder requested a bounded original-submission export',
        { filters: JSON.parse(this.filterScope(input)), rowCount: items.length, nextPageAvailable: page.nextCursor !== null },
      );
      return page;
    });
  }

  async metrics(raw: z.infer<typeof workflow.crmMetricsInputSchema>) {
    const input = normalizeIds(workflow.crmMetricsInputSchema.parse(raw));
    return this.write(async (tx) => {
      const observedAt = this.now().toISOString();
      const filtered = tx`SELECT o.id,o.submission_id,o.contact_id,o.audience,o.stage,s.record AS submission,s.attribution FROM ops.crm_opportunities o JOIN ops.crm_submissions s ON s.id=o.submission_id
        WHERE (${input.audience ?? null}::text IS NULL OR o.audience=${input.audience ?? null}) AND (${input.stage ?? null}::text IS NULL OR o.stage=${input.stage ?? null}) AND (${input.ownerUserId ?? null}::uuid IS NULL OR o.owner_user_id=${input.ownerUserId ?? null}::uuid)
        AND (${input.campaignId ?? null}::uuid IS NULL OR (s.attribution->'campaign'->>'id')::uuid=${input.campaignId ?? null}::uuid) AND (${input.sourceKey ?? null}::text IS NULL OR s.attribution->>'sourceHint'=${input.sourceKey ?? null})
        AND (${input.capturedFrom ?? null}::timestamptz IS NULL OR (s.record->>'capturedAt')::timestamptz>=${input.capturedFrom ?? null}::timestamptz) AND (${input.capturedBefore ?? null}::timestamptz IS NULL OR (s.record->>'capturedAt')::timestamptz<${input.capturedBefore ?? null}::timestamptz)`;
      const totals =
        await tx`WITH filtered AS (${filtered}) SELECT count(*)::int AS opportunities,count(DISTINCT submission_id)::int AS submissions,count(DISTINCT contact_id)::int AS contacts,count(DISTINCT submission_id) FILTER(WHERE submission->>'completedAt' IS NULL)::int AS incomplete,
        (SELECT count(*)::int FROM ops.crm_tasks t JOIN filtered f ON f.id=t.opportunity_id WHERE t.status='pending' AND t.due_at<${observedAt}::timestamptz) AS overdue,
        (SELECT count(*)::int FROM ops.crm_interactions i JOIN filtered f ON f.id=i.opportunity_id WHERE i.kind='call_invited') AS invitations,
        (SELECT count(*)::int FROM ops.crm_interactions i JOIN filtered f ON f.id=i.opportunity_id WHERE i.kind='call_booked') AS bookings FROM filtered`;
      const audiences =
        await tx`WITH filtered AS (${filtered}) SELECT audience,count(*)::int AS count FROM filtered GROUP BY audience ORDER BY audience`;
      const stages =
        await tx`WITH filtered AS (${filtered}) SELECT audience,stage,count(*)::int AS count FROM filtered GROUP BY audience,stage ORDER BY audience,stage`;
      const sources =
        await tx`WITH filtered AS (${filtered}) SELECT attribution->>'sourceHint' AS source_key,attribution->'campaign'->>'id' AS campaign_id,count(*)::int AS count FROM filtered GROUP BY source_key,campaign_id ORDER BY count DESC,source_key NULLS LAST,campaign_id NULLS LAST LIMIT 201`;
      const row = totals[0]!;
      return workflow.crmMetricsSchema.parse({
        observedAt,
        totals: {
          opportunities: row.opportunities,
          submissions: row.submissions,
          canonicalContacts: row.contacts,
          incompleteSubmissions: row.incomplete,
          overdueTasks: row.overdue,
          manualCallInvitations: row.invitations,
          manualCallBookings: row.bookings,
        },
        byAudience: audiences.map((r) => ({ audience: r.audience, count: r.count })),
        byStage: stages.map((r) => ({ audience: r.audience, stage: r.stage, count: r.count })),
        bySource: sources
          .slice(0, 200)
          .map((r) => ({ sourceKey: r.source_key ?? null, campaignId: r.campaign_id ?? null, count: r.count })),
        sourceGroupsTruncated: sources.length > 200,
      });
    }, 'repeatable read');
  }

  async listDuplicates(raw: z.infer<typeof workflow.crmDuplicateListInputSchema>) {
    const input = workflow.crmDuplicateListInputSchema.parse(raw),
      scope = 'duplicates:' + this.filterScope(input),
      cursor = this.pageCursor(input.cursor, scope);
    return this.write(async (tx) => {
      const rows = await tx`SELECT c.record,c.revision,
        (SELECT count(*)::int FROM ops.crm_contacts d LEFT JOIN ops.crm_contact_aliases ad ON ad.contact_id=d.id WHERE ad.contact_id IS NULL AND lower(d.record->>'email')=lower(c.record->>'email')) AS matches
        FROM ops.crm_contacts c LEFT JOIN ops.crm_contact_aliases a ON a.contact_id=c.id WHERE a.contact_id IS NULL
        AND EXISTS(SELECT 1 FROM ops.crm_contacts d LEFT JOIN ops.crm_contact_aliases ad ON ad.contact_id=d.id WHERE ad.contact_id IS NULL AND d.id<>c.id AND lower(d.record->>'email')=lower(c.record->>'email'))
        AND (${input.query ?? null}::text IS NULL OR strpos(lower(c.record->>'name'),lower(${input.query ?? ''}))>0 OR strpos(lower(c.record->>'email'),lower(${input.query ?? ''}))>0)
        AND (${cursor?.at ?? null}::timestamptz IS NULL OR ((c.record->>'createdAt')::timestamptz,c.id)<(${cursor?.at ?? null}::timestamptz,${cursor?.id ?? null}::uuid)) ORDER BY (c.record->>'createdAt')::timestamptz DESC,c.id DESC LIMIT ${input.limit + 1}`;
      const items = rows
          .slice(0, input.limit)
          .map((r) => ({ contact: crmContactSchema.parse(r.record), revision: r.revision, matchingUnmergedContactCount: r.matches })),
        last = items.at(-1);
      return workflow.crmDuplicatePageSchema.parse({
        items,
        nextCursor: rows.length > input.limit && last ? this.nextCursor(last.contact.createdAt, last.contact.id, scope) : null,
      });
    }, 'repeatable read');
  }
  async mergeContacts(raw: z.infer<typeof workflow.crmMergeInputSchema>, actor: string) {
    const input = normalizeIds(workflow.crmMergeInputSchema.parse(raw));
    return this.staffMutation(actor, input, 'mergeContacts', async (tx) => {
      // CRM merges are rare founder operations. This serializes graph changes,
      // including opposing merges, without locking public submissions.
      await tx`SELECT pg_advisory_xact_lock(hashtext('ops.crm.contact-merges'))`;
      const contacts =
        await tx`SELECT id,revision,record FROM ops.crm_contacts WHERE id=ANY(${tx.array([input.sourceContactId, input.targetContactId].sort())}::uuid[]) ORDER BY id FOR UPDATE`;
      const source = contacts.find((r) => r.id === input.sourceContactId),
        target = contacts.find((r) => r.id === input.targetContactId);
      if (!source || !target) throw new OutreachError('ops.crm.contact_not_found');
      if (source.revision !== input.sourceExpectedRevision || target.revision !== input.targetExpectedRevision)
        throw new OutreachError('ops.crm.revision_conflict');
      const aliases =
        await tx`SELECT contact_id FROM ops.crm_contact_aliases WHERE contact_id=ANY(${tx.array([input.sourceContactId, input.targetContactId])}::uuid[]) FOR UPDATE`;
      if (aliases.some((r) => r.contact_id === input.sourceContactId)) throw new OutreachError('ops.crm.contact_already_merged');
      if (aliases.some((r) => r.contact_id === input.targetContactId)) throw new OutreachError('ops.crm.canonical_target_required');
      const sourceRecord = crmContactSchema.parse(source.record),
        targetRecord = crmContactSchema.parse(target.record);
      if (
        sourceRecord.platformIdentity &&
        targetRecord.platformIdentity &&
        sourceRecord.platformIdentity.userId !== targetRecord.platformIdentity.userId
      )
        throw new OutreachError('ops.crm.identity_link_conflict');
      const opportunities =
        await tx`SELECT record FROM ops.crm_opportunities WHERE contact_id=${input.sourceContactId} ORDER BY id LIMIT 201 FOR UPDATE`;
      if (opportunities.length > 200) throw new OutreachError('ops.crm.merge_too_large');
      const at = this.now().toISOString();
      // Original contacts, verification, organisation links and submission
      // contact_id/answers never move. Only CRM opportunity linkage is canonical.
      await tx`UPDATE ops.crm_contact_aliases SET canonical_contact_id=${input.targetContactId},updated_at=${at} WHERE canonical_contact_id=${input.sourceContactId}`;
      await tx`INSERT INTO ops.crm_contact_aliases(contact_id,canonical_contact_id,created_at,updated_at) VALUES (${input.sourceContactId},${input.targetContactId},${at},${at})`;
      await tx`UPDATE ops.crm_contacts SET revision=revision+1 WHERE id=ANY(${tx.array([input.sourceContactId, input.targetContactId])}::uuid[])`;
      for (const result of opportunities) {
        const old = crmOpportunitySchema.parse(result.record);
        await this.saveOpportunity(tx, { ...old, contactId: input.targetContactId, revision: old.revision + 1, updatedAt: at });
        await this.activity(tx, old.id, { kind: 'operator', userId: actor.toLowerCase() }, 'note', input.reason, input.requestId);
      }
      const receipt = workflow.crmMergeReceiptSchema.parse({
        mergeId: randomUUID(),
        sourceContactId: input.sourceContactId,
        targetContactId: input.targetContactId,
        sourceRevision: source.revision + 1,
        targetRevision: target.revision + 1,
        movedOpportunityCount: opportunities.length,
        mergedAt: at,
      });
      await tx`INSERT INTO ops.crm_contact_merges(id,source_contact_id,target_contact_id,request_id,actor_user_id,merged_at,record) VALUES (${receipt.mergeId},${receipt.sourceContactId},${receipt.targetContactId},${input.requestId},${actor.toLowerCase()},${at},${this.json(tx, receipt)})`;
      const facts = {
        sourceContactId: receipt.sourceContactId,
        targetContactId: receipt.targetContactId,
        movedOpportunityCount: receipt.movedOpportunityCount,
        mergeId: receipt.mergeId,
      };
      await this.audit(tx, actor, input.requestId, 'contact', input.sourceContactId, 'contacts_merged', input.reason, facts);
      await this.audit(tx, actor, input.requestId, 'contact', input.targetContactId, 'contacts_merged', input.reason, facts);
      return receipt;
    });
  }
  async listWorkflowAudit(raw: z.infer<typeof workflow.crmWorkflowAuditListInputSchema>) {
    const input = normalizeIds(workflow.crmWorkflowAuditListInputSchema.parse(raw)),
      scope = 'workflow-audit:' + this.filterScope(input),
      cursor = this.pageCursor(input.cursor, scope);
    return this.write(async (tx) => {
      const rows =
        await tx`SELECT record FROM ops.crm_workflow_audit WHERE subject_type=${input.subjectType} AND subject_id=${input.subjectId} AND (${cursor?.at ?? null}::timestamptz IS NULL OR (occurred_at,id)<(${cursor?.at ?? null}::timestamptz,${cursor?.id ?? null}::uuid)) ORDER BY occurred_at DESC,id DESC LIMIT ${input.limit + 1}`;
      const items = rows.slice(0, input.limit).map((r) => workflow.crmWorkflowAuditSchema.parse(r.record)),
        last = items.at(-1);
      return workflow.crmWorkflowAuditPageSchema.parse({
        items,
        nextCursor: rows.length > input.limit && last ? this.nextCursor(last.occurredAt, last.id, scope) : null,
      });
    }, 'repeatable read');
  }

  private taskView(row: Record<string, unknown>) {
    return workflow.crmWorkflowTaskSchema.parse({
      task: crmTaskSchema.parse(row.record),
      revision: row.revision,
      kind: row.kind,
      createdAt: row.created_at === null ? null : new Date(String(row.created_at)).toISOString(),
    });
  }
  private async reviewedInvestor(tx: Sql, opportunity: CrmOpportunity) {
    if (opportunity.audience !== 'investor') return;
    const rows = await tx`SELECT record FROM ops.crm_submissions WHERE id=${opportunity.submissionId}`;
    const submission = crmSubmissionSchema.parse(rows[0]?.record);
    if (
      !['qualified', 'diligence', 'terms'].includes(opportunity.stage) ||
      !submission.questionnaires.some((q) => q.audience === 'investor')
    )
      throw new OutreachError('ops.crm.investor_review_required');
  }
  async listTasks(raw: z.infer<typeof workflow.crmTaskListInputSchema>) {
    const input = normalizeIds(workflow.crmTaskListInputSchema.parse(raw)),
      scope = 'tasks:' + this.filterScope(input),
      cursor = this.pageCursor(input.cursor, scope);
    return this.write(async (tx) => {
      const rows =
        await tx`SELECT * FROM ops.crm_tasks WHERE (${input.ownerUserId ?? null}::uuid IS NULL OR owner_user_id=${input.ownerUserId ?? null}::uuid) AND (${input.opportunityId ?? null}::uuid IS NULL OR opportunity_id=${input.opportunityId ?? null}::uuid) AND (${input.status ?? null}::text IS NULL OR status=${input.status ?? null}) AND (${input.dueBefore ?? null}::timestamptz IS NULL OR due_at<${input.dueBefore ?? null}::timestamptz)
        AND (${cursor?.at ?? null}::timestamptz IS NULL OR (due_at,id)>(${cursor?.at ?? null}::timestamptz,${cursor?.id ?? null}::uuid)) ORDER BY due_at,id LIMIT ${input.limit + 1}`;
      const items = rows.slice(0, input.limit).map((r) => this.taskView(r)),
        last = items.at(-1);
      return workflow.crmTaskPageSchema.parse({
        items,
        nextCursor: rows.length > input.limit && last ? this.nextCursor(last.task.dueAt, last.task.id, scope) : null,
      });
    }, 'repeatable read');
  }
  async createTask(raw: z.infer<typeof workflow.crmTaskCreateInputSchema>, actor: string) {
    const input = normalizeIds(workflow.crmTaskCreateInputSchema.parse(raw));
    return this.mutate(actor, input, 'createTask', async (tx, old, config) => {
      if (old.revision !== input.expectedRevision) throw new OutreachError('ops.crm.revision_conflict');
      if (old.stage === 'closed') throw new OutreachError('ops.crm.opportunity_closed');
      if (!config.founders.includes(input.ownerUserId)) throw new OutreachError('ops.crm.owner_not_founder');
      if (input.kind === 'call_invitation') await this.reviewedInvestor(tx, old);
      const at = this.now().toISOString(),
        task = crmTaskSchema.parse({
          id: randomUUID(),
          opportunityId: old.id,
          ownerUserId: input.ownerUserId,
          description: input.description,
          dueAt: input.dueAt,
          status: 'pending',
          updatedAt: at,
        });
      await tx`INSERT INTO ops.crm_tasks(id,opportunity_id,record,revision,kind,created_at,due_at,owner_user_id,status) VALUES (${task.id},${old.id},${tx.json(task)},1,${input.kind},${at},${task.dueAt},${task.ownerUserId},'pending')`;
      const opportunity = await this.saveOpportunity(tx, { ...old, revision: old.revision + 1, updatedAt: at });
      const view = workflow.crmWorkflowTaskSchema.parse({ task, revision: 1, kind: input.kind, createdAt: at });
      await this.audit(tx, actor, input.requestId, 'task', task.id, 'task_created', input.reason, { task: view, opportunityId: old.id });
      return workflow.crmTaskMutationReceiptSchema.parse({ task: view, opportunity });
    });
  }
  async transitionTask(raw: z.infer<typeof workflow.crmTaskTransitionInputSchema>, actor: string) {
    const input = normalizeIds(workflow.crmTaskTransitionInputSchema.parse(raw));
    return this.mutate(actor, input, 'transitionTask', async (tx, old) => {
      if (old.revision !== input.expectedRevision) throw new OutreachError('ops.crm.revision_conflict');
      const tasks = await tx`SELECT * FROM ops.crm_tasks WHERE id=${input.taskId} AND opportunity_id=${old.id} FOR UPDATE`;
      if (!tasks[0]) throw new OutreachError('ops.crm.task_not_found');
      const previous = this.taskView(tasks[0]);
      if (previous.revision !== input.expectedTaskRevision) throw new OutreachError('ops.crm.revision_conflict');
      if (previous.task.status !== 'pending') throw new OutreachError('ops.crm.task_not_pending');
      if (previous.kind === 'next_action' && old.stage !== 'closed' && !input.replacementNextAction)
        throw new OutreachError('ops.crm.next_action_required');
      if (previous.kind !== 'next_action' && input.replacementNextAction) throw new OutreachError('ops.crm.replacement_not_primary');
      const at = this.now().toISOString(),
        task = crmTaskSchema.parse({ ...previous.task, status: input.status, updatedAt: at }),
        revision = previous.revision + 1;
      await tx`UPDATE ops.crm_tasks SET record=${tx.json(task)},status=${task.status},revision=${revision} WHERE id=${task.id}`;
      const opportunity = await this.saveOpportunity(tx, {
        ...old,
        ...(previous.kind === 'next_action' && input.replacementNextAction ? { nextAction: input.replacementNextAction } : {}),
        revision: old.revision + 1,
        updatedAt: at,
      });
      if (previous.kind === 'next_action') await this.task(tx, opportunity, { actor, requestId: input.requestId, reason: input.reason });
      const view = workflow.crmWorkflowTaskSchema.parse({ ...previous, task, revision });
      await this.audit(tx, actor, input.requestId, 'task', task.id, 'task_transitioned', input.reason, {
        from: previous.task.status,
        to: task.status,
        revision,
        opportunityId: old.id,
      });
      return workflow.crmTaskMutationReceiptSchema.parse({ task: view, opportunity });
    });
  }
  async recordInteraction(raw: z.infer<typeof workflow.crmInteractionInputSchema>, actor: string) {
    const input = normalizeIds(workflow.crmInteractionInputSchema.parse(raw));
    return this.mutate(actor, input, 'recordInteraction', async (tx, old) => {
      if (old.revision !== input.expectedRevision) throw new OutreachError('ops.crm.revision_conflict');
      if (old.stage === 'closed') throw new OutreachError('ops.crm.opportunity_closed');
      if (input.kind === 'call_invited' || input.kind === 'call_booked') await this.reviewedInvestor(tx, old);
      if (Date.parse(input.occurredAt) > this.now().getTime()) throw new OutreachError('ops.crm.interaction_in_future');
      if (input.kind === 'call_booked' && Date.parse(input.scheduledAt) < Date.parse(input.occurredAt))
        throw new OutreachError('ops.crm.call_schedule_invalid');
      const existing =
        await tx`SELECT id FROM ops.crm_interactions WHERE opportunity_id=${old.id} AND kind=${input.kind} AND record->>'evidenceRef'=${input.evidenceRef}`;
      if (existing[0]) throw new OutreachError('ops.crm.interaction_already_recorded');
      const at = this.now().toISOString(),
        interaction = workflow.crmInteractionSchema.parse({
          id: randomUUID(),
          opportunityId: old.id,
          kind: input.kind,
          actorUserId: actor.toLowerCase(),
          status: 'manually_recorded',
          evidenceRef: input.evidenceRef,
          occurredAt: input.occurredAt,
          recordedAt: at,
          scheduledAt: input.kind === 'call_booked' ? input.scheduledAt : null,
        });
      await tx`INSERT INTO ops.crm_interactions(id,opportunity_id,actor_user_id,kind,occurred_at,record) VALUES (${interaction.id},${old.id},${interaction.actorUserId},${interaction.kind},${interaction.occurredAt},${this.json(tx, interaction)})`;
      const opportunity = await this.saveOpportunity(tx, {
        ...old,
        nextAction: input.kind === 'call_booked' ? { description: 'Attend the recorded call', dueAt: input.scheduledAt } : input.nextAction,
        revision: old.revision + 1,
        updatedAt: at,
      });
      await this.task(tx, opportunity, { actor, requestId: input.requestId, reason: input.reason });
      const activity = await this.activity(
        tx,
        old.id,
        { kind: 'operator', userId: actor.toLowerCase() },
        input.kind === 'follow_up' ? 'note' : input.kind,
        input.reason,
        input.evidenceRef,
      );
      await this.audit(tx, actor, input.requestId, 'opportunity', old.id, 'interaction_recorded', input.reason, {
        interaction,
        revision: opportunity.revision,
      });
      return workflow.crmInteractionReceiptSchema.parse({ interaction, activity, opportunity });
    });
  }
  async queueMessage(raw: z.infer<typeof workflow.crmQueueMessageInputSchema>, actor: string) {
    const input = normalizeIds(workflow.crmQueueMessageInputSchema.parse(raw));
    return this.mutate(actor, input, 'queueMessage', async (tx, old) => {
      if (old.revision !== input.expectedRevision) throw new OutreachError('ops.crm.revision_conflict');
      if (old.stage === 'closed') throw new OutreachError('ops.crm.opportunity_closed');
      if (input.kind === 'call_invitation') await this.reviewedInvestor(tx, old);
      const rows = await tx`SELECT record FROM ops.crm_submissions WHERE id=${old.submissionId}`;
      const original = crmSubmissionSchema.parse(rows[0]?.record),
        id = randomUUID();
      const activity = await this.activity(
        tx,
        old.id,
        { kind: 'operator', userId: actor.toLowerCase() },
        'email_status',
        `Message queued: ${input.kind}`,
        id,
      );
      const wire = workflow.guestNotificationSendInputSchema.parse({
        businessKey: `staff_message:${id}`,
        contactId: original.contactId,
        submissionId: original.submissionId,
        recipientEmail: original.contact.email,
        message: { kind: input.kind, activityId: activity.id, staffText: input.staffText },
      });
      const at = this.now().toISOString();
      await tx`INSERT INTO ops.crm_outbox(id,business_key,submission_id,kind,status,payload,created_at,updated_at,
        error_code,dispatch_payload,opportunity_id,actor_user_id)
        VALUES (${id},${wire.businessKey},${original.submissionId},${input.kind},'unconfigured',${tx.json({ activityId: activity.id })},
        ${at},${at},'ops.crm.notification_unconfigured',${tx.json(wire)},${old.id},${actor.toLowerCase()})`;
      const opportunity = await this.saveOpportunity(tx, { ...old, revision: old.revision + 1, updatedAt: at });
      const message = workflow.crmMessageSchema.parse({
        id,
        opportunityId: old.id,
        submissionId: original.submissionId,
        kind: input.kind,
        staffText: input.staffText,
        actorUserId: actor.toLowerCase(),
        status: 'unconfigured',
        createdAt: at,
        notification: null,
      });
      await this.audit(tx, actor, input.requestId, 'opportunity', old.id, 'message_queued', input.reason, {
        messageId: id,
        kind: input.kind,
        activityId: activity.id,
        recipientSource: 'original_submission',
      });
      return workflow.crmQueueMessageReceiptSchema.parse({ opportunity, activity, message });
    });
  }
  async listMessages(raw: z.infer<typeof workflow.crmMessageListInputSchema>) {
    const input = normalizeIds(workflow.crmMessageListInputSchema.parse(raw));
    const scope = `messages:${input.opportunityId}`,
      cursor = this.pageCursor(input.cursor, scope);
    return this.write(async (tx) => {
      const rows = await tx`SELECT * FROM ops.crm_outbox WHERE opportunity_id=${input.opportunityId}
        AND (${cursor?.at ?? null}::timestamptz IS NULL OR (created_at,id)<(${cursor?.at ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
        ORDER BY created_at DESC,id DESC LIMIT ${input.limit + 1}`;
      const items = rows.slice(0, input.limit).map((row) =>
        workflow.crmMessageSchema.parse({
          id: row.id,
          opportunityId: row.opportunity_id,
          submissionId: row.submission_id,
          kind: row.kind,
          // Founder-only: the text lives in the stored wire payload; null when it is gone. Reached only through staffRead.
          staffText: staffTextOf(row.dispatch_payload),
          actorUserId: row.actor_user_id,
          status: row.status,
          createdAt: new Date(row.created_at).toISOString(),
          notification: row.notification_receipt,
        }),
      );
      const last = items.at(-1);
      return workflow.crmMessagePageSchema.parse({
        items,
        nextCursor: rows.length > input.limit && last ? this.nextCursor(last.createdAt, last.id, scope) : null,
      });
    }, 'repeatable read');
  }

  private async saveOpportunity(tx: Sql, raw: unknown): Promise<CrmOpportunity> {
    const row = crmOpportunitySchema.parse(raw);
    await tx`UPDATE ops.crm_opportunities SET contact_id=${row.contactId},stage=${row.stage},owner_user_id=${row.ownerUserId},revision=${row.revision},record=${tx.json(row)} WHERE id=${row.id}`;
    return row;
  }
  private async task(tx: Sql, opportunity: CrmOpportunity, audit?: { actor: string; requestId: string; reason: string }): Promise<void> {
    const previous =
      await tx`SELECT id,record,kind FROM ops.crm_tasks WHERE opportunity_id=${opportunity.id} AND (kind='next_action' OR ${opportunity.stage === 'closed'}) FOR UPDATE`;
    for (const p of previous) {
      const row = crmTaskSchema.parse(p.record);
      if (row.status === 'pending') {
        await tx`UPDATE ops.crm_tasks SET status='cancelled',revision=revision+1,record=${tx.json({ ...row, status: 'cancelled', updatedAt: this.now().toISOString() })} WHERE id=${row.id}`;
        if (audit)
          await this.audit(tx, audit.actor, audit.requestId, 'task', row.id, 'task_transitioned', audit.reason, {
            from: 'pending',
            to: 'cancelled',
            opportunityId: opportunity.id,
            cause: opportunity.stage === 'closed' ? 'opportunity_closed' : 'next_action_replaced',
          });
      }
    }
    if (opportunity.nextAction) {
      const task = crmTaskSchema.parse({
        id: randomUUID(),
        opportunityId: opportunity.id,
        ownerUserId: opportunity.ownerUserId,
        ...opportunity.nextAction,
        status: 'pending',
        updatedAt: this.now().toISOString(),
      });
      await tx`INSERT INTO ops.crm_tasks(id,opportunity_id,record,kind,created_at,due_at,owner_user_id,status) VALUES (${task.id},${opportunity.id},${tx.json(task)},'next_action',${task.updatedAt},${task.dueAt},${task.ownerUserId},${task.status})`;
      if (audit)
        await this.audit(tx, audit.actor, audit.requestId, 'task', task.id, 'task_created', audit.reason, {
          kind: 'next_action',
          opportunityId: opportunity.id,
          task,
        });
    }
  }
  private async activity(
    tx: Sql,
    opportunityId: string,
    actor: CrmActivity['actor'],
    kind: CrmActivity['kind'],
    note: string | null,
    referenceId: string | null,
  ): Promise<CrmActivity> {
    const rows = await tx`SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM ops.crm_activities WHERE opportunity_id=${opportunityId}`;
    const activity = crmActivitySchema.parse({
      id: randomUUID(),
      opportunityId,
      sequence: Number(rows[0]?.sequence),
      kind,
      actor,
      note,
      referenceId,
      occurredAt: this.now().toISOString(),
    });
    await tx`INSERT INTO ops.crm_activities(id,opportunity_id,sequence,record) VALUES (${activity.id},${opportunityId},${activity.sequence},${tx.json(activity)})`;
    return activity;
  }
}
const uuidSchema = z.string().guid();
function staffTextOf(payload: unknown): string | null {
  const message = (payload as { message?: { staffText?: unknown } } | null)?.message;
  return typeof message?.staffText === 'string' && message.staffText.length > 0 ? message.staffText : null;
}
const cursorSchema = z.object({ at: z.string().datetime({ offset: true }), id: uuidSchema }).strict();
function outreachCaptureReceipt(value: unknown) {
  return outreachCaptureReceiptSchema.parse(value);
}

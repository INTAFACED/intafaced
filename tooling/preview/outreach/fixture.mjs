/**
 * In-memory stand-in for svc-ops outreach, identity founder login and account
 * controls, for the local click-through preview only.
 *
 * One store feeds both sides: an enquiry sent from the public questionnaire
 * appears in the founder CRM. Every reply is parsed with the shared contract
 * schemas, so the preview refuses to show a shape the real services could not
 * send. Nothing here is persisted, emailed or deployed; all people are test data.
 */
import { createHash, randomUUID } from 'node:crypto';
import { fixtureFounderEnrolmentHandlers } from './fixture-founder-enrolment.mjs';
import { fixtureFounderSecurityHandlers } from './fixture-founder-security.mjs';

const DAY = 86_400_000;
export const NITRO = '00000000-0000-4000-8000-000000000001';
export const PHANTOM = '00000000-0000-4000-8000-000000000002';
const UNCONFIGURED = 'ops.crm.notification_unconfigured';

export class FixtureError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/**
 * `notifyConfigured` mirrors svc-ops' notification link (notifyUrl plus a secret
 * of 32+ characters, notification-client.ts). It is a configuration dependency,
 * not email. Launch has it configured, so that is the default here: erasure
 * then completes the way production does (one pending submission notification
 * is cleared per advance, records are removed on the last). Pass false to see
 * the unconfigured path, where erasure stays pending_notify.
 */
export function createOutreachFixture(c, clock = () => Date.now(), { notifyConfigured = true } = {}) {
  const iso = (offset = 0) => new Date(clock() + offset).toISOString();
  const contacts = new Map(); // id -> { record, revision }
  const aliases = new Map(); // merged contact id -> canonical id
  const submissions = new Map(); // id -> { record, token, expiresAt, initialContact, firstCompletedAt, deliveries }
  const opportunities = new Map();
  const organisations = new Map(); // id -> crmOrganisation
  const activities = new Map(); // opportunity id -> []
  const tasks = []; // crmWorkflowTask
  const messages = [];
  const audits = [];
  const campaigns = new Map();
  const mappings = new Map();
  const reviews = new Map(); // canonical contact id -> retention review
  const erasures = new Map(); // intent id -> status
  const erasureScopes = new Map(); // intent id -> { contactIds, submissionIds, opportunityIds, organisationIds }
  const replies = new Map(); // `${scope}:${requestId}` -> { input, data }
  const controls = new Map(); // `${area}:${userId}` -> { version, restricted, history }

  const canonical = (contactId) => aliases.get(contactId) ?? contactId;
  const contact = (contactId) => contacts.get(contactId)?.record;
  const nextReview = () => iso(2 * DAY);

  function remember(scope, requestId, input, run) {
    const key = `${scope}:${requestId}`;
    const body = JSON.stringify({ ...input, continuationToken: undefined });
    const prior = replies.get(key);
    if (prior) {
      if (prior.input !== body) throw new FixtureError('ops.crm.idempotency_conflict', 409);
      return structuredClone(prior.data);
    }
    const data = run();
    replies.set(key, { input: body, data: structuredClone(data) });
    return data;
  }

  function activity(opportunityId, actor, kind, note = null, referenceId = null) {
    const rows = activities.get(opportunityId) ?? [];
    const row = c.crmActivitySchema.parse({
      id: randomUUID(),
      opportunityId,
      sequence: rows.length + 1,
      kind,
      actor,
      note,
      referenceId,
      occurredAt: iso(),
    });
    rows.push(row);
    activities.set(opportunityId, rows);
    return row;
  }

  function audit(input, subjectType, subjectId, kind, actorUserId) {
    audits.unshift(
      c.crmWorkflowAuditSchema.parse({
        id: randomUUID(),
        requestId: input.requestId,
        actorUserId,
        subjectType,
        subjectId,
        kind,
        reason: input.reason ?? 'Founder action',
        occurredAt: iso(),
        facts: {},
      }),
    );
  }

  function saveOpportunity(next) {
    const parsed = c.crmOpportunitySchema.parse({ ...next, updatedAt: iso() });
    opportunities.set(parsed.id, parsed);
    return parsed;
  }

  function bump(opportunityId, expectedRevision) {
    const current = opportunities.get(opportunityId);
    if (!current) throw new FixtureError('ops.crm.not_found', 404);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new FixtureError('ops.crm.revision_conflict', 409);
    return saveOpportunity({ ...current, revision: current.revision + 1 });
  }

  function openOpportunity(submissionId, contactId, audience, organisationId = null) {
    const at = iso();
    const opportunity = saveOpportunity({
      id: randomUUID(),
      contactId,
      organisationId,
      submissionId,
      audience,
      stage: 'new',
      ownerUserId: NITRO,
      revision: 1,
      nextAction: { description: 'Review enquiry', dueAt: nextReview() },
      closedDisposition: null,
      closingEvidenceRef: null,
      createdAt: at,
      updatedAt: at,
      ...(audience === 'investor' ? { indicativeContribution: { status: 'undecided' } } : {}),
    });
    tasks.push(
      c.crmWorkflowTaskSchema.parse({
        task: {
          id: randomUUID(),
          opportunityId: opportunity.id,
          ownerUserId: NITRO,
          description: opportunity.nextAction.description,
          dueAt: opportunity.nextAction.dueAt,
          status: 'pending',
          updatedAt: at,
        },
        revision: 1,
        kind: 'next_action',
        createdAt: at,
      }),
    );
    activity(opportunity.id, { kind: 'system', jobId: submissionId }, 'assigned', null, NITRO);
    return opportunity;
  }

  function authenticate(input) {
    const saved = submissions.get(input.submissionId);
    const underErasure = [...erasureScopes.values()].some((scope) => scope.submissionIds.includes(input.submissionId));
    if (!saved || underErasure || saved.token !== input.continuationToken || Date.parse(saved.expiresAt) <= clock())
      throw new FixtureError('ops.crm.continuation_invalid');
    return saved;
  }

  const draft = (saved) =>
    c.outreachDraftSchema.parse({
      submissionId: saved.record.submissionId,
      revision: saved.record.revision,
      contact: saved.record.contact,
      questionnaires: saved.record.questionnaires,
      capturedAt: saved.record.capturedAt,
      completedAt: saved.record.completedAt,
      continuationExpiresAt: saved.expiresAt,
    });

  // Public questionnaire API, mirroring svc-ops crm.ts capture/resume/answer/addInterests.
  const publicApi = {
    capture(raw) {
      const input = c.outreachCaptureInputSchema.parse(raw);
      return remember('prospect', input.requestId, input, () => {
        const at = iso();
        const contactId = randomUUID();
        const submissionId = randomUUID();
        // Like svc-ops crm.ts capture: a named organisation becomes a record linked to the contact.
        const organisationId = input.contact.organisationName ? randomUUID() : null;
        if (organisationId)
          organisations.set(
            organisationId,
            c.crmOrganisationSchema.parse({
              id: organisationId,
              name: input.contact.organisationName,
              website: null,
              countries: input.contact.country ? [input.contact.country] : [],
              createdAt: at,
            }),
          );
        contacts.set(contactId, {
          revision: 1,
          record: c.crmContactSchema.parse({
            id: contactId,
            name: input.contact.name,
            email: input.contact.email,
            emailEvidence: { status: 'unverified' },
            organisationIds: organisationId ? [organisationId] : [],
            interests: input.contact.interests,
            platformIdentity: null,
            createdAt: at,
            updatedAt: at,
          }),
        });
        const expiresAt = iso(30 * DAY);
        submissions.set(submissionId, {
          token: input.continuationToken,
          expiresAt,
          initialContact: input.contact,
          firstCompletedAt: null,
          deliveries: [{ kind: 'enquiry_acknowledgement', status: 'unconfigured', error_code: UNCONFIGURED }],
          record: c.crmSubmissionSchema.parse({
            submissionId,
            contactId,
            revision: 1,
            contact: input.contact,
            questionnaires: [],
            capturedAt: at,
            completedAt: null,
          }),
        });
        for (const audience of input.contact.interests) openOpportunity(submissionId, contactId, audience, organisationId);
        return c.outreachCaptureReceiptSchema.parse({ submissionId, revision: 1, capturedAt: at, continuationExpiresAt: expiresAt });
      });
    },
    resume(raw) {
      return draft(authenticate(c.outreachContinuationInputSchema.parse(raw)));
    },
    answer(raw) {
      const input = c.outreachQuestionnaireInputSchema.parse(raw);
      const saved = authenticate(input);
      return remember(`prospect:${input.submissionId}`, input.requestId, input, () => {
        const old = saved.record;
        if (old.revision !== input.expectedRevision) throw new FixtureError('ops.crm.revision_conflict');
        if (!old.contact.interests.includes(input.questionnaire.audience)) throw new FixtureError('ops.crm.audience_not_selected');
        if (old.questionnaires.some((q) => q.audience === input.questionnaire.audience))
          throw new FixtureError('ops.crm.answers_already_preserved');
        const questionnaires = [...old.questionnaires, input.questionnaire];
        const completedAt = questionnaires.length === old.contact.interests.length ? iso() : null;
        saved.record = c.crmSubmissionSchema.parse({ ...old, revision: old.revision + 1, questionnaires, completedAt });
        saved.firstCompletedAt ??= completedAt;
        const opportunity = [...opportunities.values()].find(
          (row) => row.submissionId === input.submissionId && row.audience === input.questionnaire.audience,
        );
        if (input.questionnaire.audience === 'investor')
          saveOpportunity({
            ...opportunity,
            indicativeContribution: input.questionnaire.answers.indicativeContribution,
            revision: opportunity.revision + 1,
          });
        activity(opportunity.id, { kind: 'prospect', submissionId: input.submissionId }, 'questionnaire_submitted', null, input.requestId);
        return draft(saved);
      });
    },
    addInterests(raw) {
      const input = c.outreachAddInterestsInputSchema.parse(raw);
      const saved = authenticate(input);
      return remember(`prospect:${input.submissionId}`, input.requestId, input, () => {
        const old = saved.record;
        if (old.revision !== input.expectedRevision) throw new FixtureError('ops.crm.revision_conflict');
        const additions = input.interests.filter((interest) => !old.contact.interests.includes(interest));
        if (additions.length) {
          const organisationId = contact(old.contactId)?.organisationIds[0] ?? null;
          for (const audience of additions) openOpportunity(input.submissionId, canonical(old.contactId), audience, organisationId);
          saved.record = c.crmSubmissionSchema.parse({
            ...old,
            revision: old.revision + 1,
            contact: { ...old.contact, interests: [...old.contact.interests, ...additions] },
            completedAt: null,
          });
        }
        return draft(saved);
      });
    },
  };

  // Newest first; reversing insertion order first keeps same-millisecond seeds newest first too.
  const visible = () => [...opportunities.values()].reverse().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  // Like svc-ops listOpportunities: the search is literal, case-insensitive, on name or email.
  const hit = (who, query) => who.name.toLowerCase().includes(query) || who.email.toLowerCase().includes(query);
  // The contacts merged into this one, oldest merge first (svc-ops orders by alias created_at).
  // A contact in any erasure intent (pending or complete) is never found or named through an alias, like the svc-ops NOT EXISTS clause.
  const inErasureIntent = (contactId) => [...erasureScopes.values()].some((scope) => scope.contactIds.includes(contactId));
  const mergedAway = (canonicalContactId) =>
    [...aliases]
      .filter(([from, to]) => to === canonicalContactId && !inErasureIntent(from))
      .map(([from]) => contact(from))
      .filter(Boolean);
  const matches = (row, input) => {
    const who = contact(row.contactId);
    const query = input.query?.toLowerCase();
    return (
      (!input.audience || row.audience === input.audience) &&
      (!input.stage || row.stage === input.stage) &&
      (!input.ownerUserId || row.ownerUserId === input.ownerUserId) &&
      // A merged-away contact's name or email finds the enquiry that now sits under the surviving contact.
      (!query || hit(who, query) || mergedAway(row.contactId).some((old) => hit(old, query)))
    );
  };
  // Only when the visible contact does not match itself: the old name the search came through, so the row can say "also: ...".
  const aliasMatch = (row, query) => {
    if (!query || hit(contact(row.contactId), query.toLowerCase())) return null;
    const old = mergedAway(row.contactId).find((value) => hit(value, query.toLowerCase()));
    return old ? { opportunityId: row.id, name: old.name } : null;
  };
  const summary = (submissionId) => {
    const saved = submissions.get(submissionId);
    return { submissionId, completedAt: saved.record.completedAt, organisationName: saved.record.contact.organisationName ?? null };
  };
  const noSource = (capturedAt) => ({
    sourceHint: null,
    sourceMappingId: null,
    sourceMappingRevision: null,
    campaign: null,
    recipientLinkage: 'unknown',
    capturedAt,
  });
  const cluster = (canonicalContactId) => [
    canonicalContactId,
    ...[...aliases].filter(([, to]) => to === canonicalContactId).map(([from]) => from),
  ];

  function controlState(target) {
    const key = `${target.area}:${target.userId}`;
    if (!controls.has(key)) controls.set(key, { version: '0', restricted: false, history: [] });
    return controls.get(key);
  }

  // svc-ops privacy.ts assertContactWritable: a contact in an erasure intent takes no further privacy action.
  function assertContactWritable(contactId) {
    for (const [intentId, scope] of erasureScopes)
      if (scope.contactIds.includes(contactId))
        throw new FixtureError(erasures.get(intentId).status === 'complete' ? 'ops.crm.contact_erased' : 'ops.crm.erasure_pending', 409);
  }

  // svc-ops crm_apply_erasure: runs once every submission notification is cleared.
  function applyErasure(scope) {
    for (const id of scope.opportunityIds) {
      opportunities.delete(id);
      activities.delete(id);
      for (let i = tasks.length - 1; i >= 0; i -= 1) if (tasks[i].task.opportunityId === id) tasks.splice(i, 1);
      for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i].opportunityId === id) messages.splice(i, 1);
    }
    for (const id of scope.submissionIds) submissions.delete(id);
    for (const id of scope.organisationIds) organisations.delete(id);
    for (const id of scope.contactIds) {
      contacts.delete(id);
      aliases.delete(id);
    }
    reviews.delete(scope.contactIds[0]);
  }

  // svc-ops task(): cancel the pending next-action task, then open one for the opportunity's current next action and owner.
  function replaceNextActionTask(opportunity, replace) {
    for (const row of tasks)
      if (row.task.opportunityId === opportunity.id && row.kind === 'next_action' && row.task.status === 'pending') {
        row.revision += 1;
        row.task = { ...row.task, status: 'cancelled', updatedAt: iso() };
        audit(replace, 'task', row.task.id, 'task_transitioned', NITRO);
      }
    if (opportunity.nextAction) {
      const at = iso();
      const created = c.crmWorkflowTaskSchema.parse({
        task: {
          id: randomUUID(),
          opportunityId: opportunity.id,
          ownerUserId: opportunity.ownerUserId,
          ...opportunity.nextAction,
          status: 'pending',
          updatedAt: at,
        },
        revision: 1,
        kind: 'next_action',
        createdAt: at,
      });
      tasks.push(created);
      audit(replace, 'task', created.task.id, 'task_created', NITRO);
    }
  }

  // Founder procedures, keyed by the edge path after /api/<module>/trpc/.
  const founderApi = {
    'auth.login': () => ({
      userId: NITRO,
      accessToken: 'test-founder-access-token',
      refreshToken: 'test-founder-refresh-token',
      // The console refuses sessions longer than four hours.
      expiresAt: iso(4 * 3_600_000 - 60_000),
    }),
    'auth.logout': () => ({ signedOut: true }),
    'accountControls.operatorStatus': () =>
      c.accountOperatorEntitlementSchema.parse({ status: 'enabled', userId: NITRO, version: '1', changedAt: iso() }),
    'accountControls.getState': (input) => {
      const state = controlState(input.target ?? input);
      return { target: input.target ?? input, version: state.version, restricted: state.restricted };
    },
    'accountControls.history': (input) => controlState(input.target ?? input).history,
    'accountControls.change': (input) => {
      const state = controlState(input.target);
      const before = { target: input.target, version: state.version, restricted: state.restricted };
      const changed = state.restricted !== (input.action === 'restrict');
      if (changed) {
        state.restricted = input.action === 'restrict';
        state.version = String(Number(state.version) + 1);
      }
      const result = {
        auditId: randomUUID(),
        requestId: input.requestId,
        target: input.target,
        action: input.action,
        reason: input.reason,
        occurredAt: iso(),
        actorUserId: NITRO,
        before,
        after: { target: input.target, version: state.version, restricted: state.restricted },
        outcome: changed ? 'changed' : 'unchanged',
        changed,
      };
      state.history.unshift(result);
      return result;
    },
    'outreach.owners': () => ({
      ownerUserIds: [NITRO, PHANTOM],
      initialOwnerUserId: NITRO,
      owners: [
        { userId: NITRO, displayName: 'Nitro' },
        { userId: PHANTOM, displayName: 'Phantom' },
      ],
    }),
    'outreach.listOpportunities': (raw) => {
      const input = c.crmListInputSchema.parse(raw);
      const items = visible()
        .filter((row) => matches(row, input))
        .slice(0, input.limit);
      const aliasMatches = items.map((row) => aliasMatch(row, input.query)).filter(Boolean);
      return c.crmOpportunityPageSchema.parse({
        items,
        contacts: [...new Set(items.map((row) => row.contactId))].map(contact),
        submissions: [...new Set(items.map((row) => row.submissionId))].map(summary),
        ...(aliasMatches.length ? { aliasMatches } : {}),
        nextCursor: null,
      });
    },
    'outreach.getOpportunity': (input) => {
      const opportunity = opportunities.get(input.opportunityId);
      if (!opportunity) return null;
      const saved = submissions.get(opportunity.submissionId);
      return {
        opportunity,
        contact: contact(opportunity.contactId),
        submission: saved.record,
        organisation: (opportunity.organisationId && organisations.get(opportunity.organisationId)) || null,
        activities: activities.get(opportunity.id) ?? [],
        tasks: tasks.filter((row) => row.task.opportunityId === opportunity.id).map((row) => row.task),
        deliveries: saved.deliveries,
      };
    },
    'outreach.getContactProvenance': (raw) => {
      const input = c.crmContactProvenanceInputSchema.parse(raw);
      const original = contacts.get(input.contactId);
      const target = contacts.get(canonical(input.contactId));
      if (!original || !target) throw new FixtureError('ops.crm.not_found', 404);
      return c.crmContactProvenanceSchema.parse({
        originalContact: original.record,
        canonicalContact: target.record,
        originalRevision: original.revision,
        canonicalRevision: target.revision,
        firstKnownSource: null,
        latestKnownSource: null,
      });
    },
    'outreach.assign': (raw) => {
      const input = c.crmAssignmentInputSchema.parse(raw);
      return remember(NITRO, input.requestId, input, () => {
        const next = bump(input.opportunityId, input.expectedRevision);
        activity(next.id, { kind: 'operator', userId: NITRO }, 'assigned', null, input.ownerUserId);
        const reassigned = saveOpportunity({ ...next, ownerUserId: input.ownerUserId });
        // Like svc-ops assign: the pending next-action task is replaced by one owned by the new owner.
        replaceNextActionTask(reassigned, { requestId: input.requestId, reason: 'Founder reassigned the opportunity' });
        return reassigned;
      });
    },
    // Like svc-ops updateNextAction: only the next action changes. No stage, no reason; the pending task is replaced.
    'outreach.updateNextAction': (raw) => {
      const input = c.crmNextActionInputSchema.parse(raw);
      return remember(NITRO, input.requestId, input, () => {
        const current = opportunities.get(input.opportunityId);
        if (!current) throw new FixtureError('ops.crm.not_found', 404);
        if (current.revision !== input.expectedRevision) throw new FixtureError('ops.crm.revision_conflict', 409);
        if (current.stage === 'closed') throw new FixtureError('ops.crm.opportunity_closed', 409);
        const dueAt = new Date(input.dueAt).toISOString();
        const saved = saveOpportunity({
          ...current,
          nextAction: { description: input.description, dueAt },
          revision: current.revision + 1,
        });
        replaceNextActionTask(saved, { requestId: input.requestId, reason: 'Founder edited the next action' });
        activity(saved.id, { kind: 'operator', userId: NITRO }, 'next_action_changed', input.description, dueAt);
        return saved;
      });
    },
    'outreach.changeStage': (raw) => {
      const input = c.crmStageChangeInputSchema.parse(raw);
      return remember(NITRO, input.requestId, input, () => {
        const current = opportunities.get(input.opportunityId);
        if (!current) throw new FixtureError('ops.crm.not_found', 404);
        if (!c.crmStageFitsAudience(current.audience, input.stage)) throw new FixtureError('ops.crm.stage_invalid');
        const next = bump(input.opportunityId, input.expectedRevision);
        for (const row of tasks)
          if (row.task.opportunityId === next.id && row.kind === 'next_action' && row.task.status === 'pending') {
            row.revision += 1;
            row.task =
              input.nextAction === null
                ? { ...row.task, status: 'cancelled', updatedAt: iso() }
                : { ...row.task, ...input.nextAction, updatedAt: iso() };
          }
        activity(next.id, { kind: 'operator', userId: NITRO }, 'stage_changed', input.reason);
        audit(input, 'opportunity', next.id, 'stage_changed', NITRO);
        return saveOpportunity({
          ...next,
          stage: input.stage,
          nextAction: input.nextAction,
          closedDisposition: input.closedDisposition,
          closingEvidenceRef: input.closingEvidenceRef,
        });
      });
    },
    'outreach.addNote': (raw) => {
      const input = c.crmNoteInputSchema.parse(raw);
      return remember(NITRO, input.requestId, input, () => {
        if (!opportunities.has(input.opportunityId)) throw new FixtureError('ops.crm.not_found', 404);
        return activity(input.opportunityId, { kind: 'operator', userId: NITRO }, 'note', input.note);
      });
    },
    'outreach.metrics': (raw) => {
      const input = c.crmMetricsInputSchema.parse(raw);
      const rows = visible().filter((row) => matches(row, input));
      const groups = (key) => [...new Set(rows.map(key))];
      return c.crmMetricsSchema.parse({
        observedAt: iso(),
        totals: {
          opportunities: rows.length,
          submissions: new Set(rows.map((row) => row.submissionId)).size,
          canonicalContacts: new Set(rows.map((row) => row.contactId)).size,
          incompleteSubmissions: [...new Set(rows.map((row) => row.submissionId))].filter((id) => !submissions.get(id).record.completedAt)
            .length,
          overdueTasks: tasks.filter((row) => row.task.status === 'pending' && Date.parse(row.task.dueAt) < clock()).length,
          manualCallInvitations: rows.flatMap((row) => activities.get(row.id) ?? []).filter((row) => row.kind === 'call_invited').length,
          manualCallBookings: rows.flatMap((row) => activities.get(row.id) ?? []).filter((row) => row.kind === 'call_booked').length,
        },
        byAudience: groups((row) => row.audience).map((audience) => ({
          audience,
          count: rows.filter((row) => row.audience === audience).length,
        })),
        byStage: groups((row) => `${row.audience}:${row.stage}`).map((key) => {
          const [audience, stage] = key.split(':');
          return { audience, stage, count: rows.filter((row) => row.audience === audience && row.stage === stage).length };
        }),
        bySource: rows.length ? [{ sourceKey: null, campaignId: null, count: rows.length }] : [],
        sourceGroupsTruncated: false,
      });
    },
    'outreach.listTasks': (raw) => {
      const input = c.crmTaskListInputSchema.parse(raw);
      const items = tasks.filter(
        (row) =>
          (!input.opportunityId || row.task.opportunityId === input.opportunityId) &&
          (!input.status || row.task.status === input.status) &&
          (!input.ownerUserId || row.task.ownerUserId === input.ownerUserId) &&
          (!input.dueBefore || Date.parse(row.task.dueAt) < Date.parse(input.dueBefore)),
      );
      return c.crmTaskPageSchema.parse({ items: items.slice(0, input.limit), nextCursor: null });
    },
    'outreach.createTask': (raw) => {
      const input = c.crmTaskCreateInputSchema.parse(raw);
      return remember(NITRO, input.requestId, input, () => {
        const opportunity = bump(input.opportunityId, input.expectedRevision);
        const row = c.crmWorkflowTaskSchema.parse({
          task: {
            id: randomUUID(),
            opportunityId: opportunity.id,
            ownerUserId: input.ownerUserId,
            description: input.description,
            dueAt: input.dueAt,
            status: 'pending',
            updatedAt: iso(),
          },
          revision: 1,
          kind: input.kind,
          createdAt: iso(),
        });
        tasks.push(row);
        audit(input, 'task', row.task.id, 'task_created', NITRO);
        return c.crmTaskMutationReceiptSchema.parse({ task: row, opportunity });
      });
    },
    'outreach.transitionTask': (raw) => {
      const input = c.crmTaskTransitionInputSchema.parse(raw);
      return remember(NITRO, input.requestId, input, () => {
        const row = tasks.find((item) => item.task.id === input.taskId && item.task.opportunityId === input.opportunityId);
        if (!row) throw new FixtureError('ops.crm.not_found', 404);
        if (row.revision !== input.expectedTaskRevision) throw new FixtureError('ops.crm.revision_conflict', 409);
        let opportunity = bump(input.opportunityId, input.expectedRevision);
        row.revision += 1;
        row.task = { ...row.task, status: input.status, updatedAt: iso() };
        if (input.replacementNextAction) {
          opportunity = saveOpportunity({ ...opportunity, nextAction: input.replacementNextAction });
          tasks.push(
            c.crmWorkflowTaskSchema.parse({
              task: {
                id: randomUUID(),
                opportunityId: opportunity.id,
                ownerUserId: opportunity.ownerUserId,
                ...input.replacementNextAction,
                status: 'pending',
                updatedAt: iso(),
              },
              revision: 1,
              kind: 'next_action',
              createdAt: iso(),
            }),
          );
        }
        audit(input, 'task', row.task.id, 'task_transitioned', NITRO);
        return c.crmTaskMutationReceiptSchema.parse({ task: row, opportunity });
      });
    },
    'outreach.recordInteraction': (raw) => {
      const input = c.crmInteractionInputSchema.parse(raw);
      return remember(NITRO, input.requestId, input, () => {
        let opportunity = bump(input.opportunityId, input.expectedRevision);
        opportunity = saveOpportunity({
          ...opportunity,
          nextAction: input.nextAction ?? { description: 'Attend the recorded call', dueAt: input.scheduledAt },
        });
        const interaction = {
          id: randomUUID(),
          opportunityId: opportunity.id,
          kind: input.kind,
          actorUserId: NITRO,
          status: 'manually_recorded',
          evidenceRef: input.evidenceRef,
          occurredAt: input.occurredAt,
          recordedAt: iso(),
          scheduledAt: input.scheduledAt ?? null,
        };
        const row = activity(
          opportunity.id,
          { kind: 'operator', userId: NITRO },
          input.kind === 'follow_up' ? 'note' : input.kind,
          input.reason,
          input.evidenceRef,
        );
        audit(input, 'opportunity', opportunity.id, 'interaction_recorded', NITRO);
        return c.crmInteractionReceiptSchema.parse({ interaction, activity: row, opportunity });
      });
    },
    'outreach.listWorkflowAudit': (raw) => {
      const input = c.crmWorkflowAuditListInputSchema.parse(raw);
      const items = audits.filter((row) => row.subjectType === input.subjectType && row.subjectId === input.subjectId);
      return c.crmWorkflowAuditPageSchema.parse({ items: items.slice(0, input.limit), nextCursor: null });
    },
    'outreach.listMessages': (raw) => {
      const input = c.crmMessageListInputSchema.parse(raw);
      return c.crmMessagePageSchema.parse({
        items: messages.filter((row) => row.opportunityId === input.opportunityId).reverse(),
        nextCursor: null,
      });
    },
    'outreach.queueMessage': (raw) => {
      const input = c.crmQueueMessageInputSchema.parse(raw);
      return remember(NITRO, input.requestId, input, () => {
        const opportunity = bump(input.opportunityId, input.expectedRevision);
        // Mail is not configured in the preview, so a queued message honestly stays unconfigured.
        const message = c.crmMessageSchema.parse({
          id: randomUUID(),
          opportunityId: opportunity.id,
          submissionId: opportunity.submissionId,
          kind: input.kind,
          // Founder-only, like svc-ops: served by outreach.listMessages and the queue receipt, never by a public route.
          staffText: input.staffText,
          actorUserId: NITRO,
          status: 'unconfigured',
          createdAt: iso(),
          notification: null,
        });
        messages.push(message);
        audit(input, 'opportunity', opportunity.id, 'message_queued', NITRO);
        const row = activity(
          opportunity.id,
          { kind: 'operator', userId: NITRO },
          'email_status',
          `Message queued: ${input.kind}`,
          message.id,
        );
        return c.crmQueueMessageReceiptSchema.parse({ opportunity, activity: row, message });
      });
    },
    'outreach.listCampaigns': (raw) => {
      const input = c.crmCampaignListInputSchema.parse(raw);
      return c.crmCampaignPageSchema.parse({ items: [...campaigns.values()].slice(0, input.limit), nextCursor: null });
    },
    'outreach.upsertCampaign': (raw) => {
      const input = c.crmCampaignWriteInputSchema.parse(raw);
      return remember(NITRO, input.requestId, input, () => {
        const prior = campaigns.get(input.id);
        if ((prior?.revision ?? 0) !== input.expectedRevision) throw new FixtureError('ops.crm.revision_conflict', 409);
        const { requestId, expectedRevision, reason, ...fields } = input;
        const row = c.crmCampaignSchema.parse({
          ...fields,
          revision: expectedRevision + 1,
          createdAt: prior?.createdAt ?? iso(),
          updatedAt: iso(),
        });
        campaigns.set(row.id, row);
        audit(input, 'campaign', row.id, 'campaign_written', NITRO);
        return row;
      });
    },
    'outreach.listSourceMappings': (raw) => {
      const input = c.crmSourceMappingListInputSchema.parse(raw);
      const items = [...mappings.values()].filter(
        (row) => (!input.campaignId || row.campaignId === input.campaignId) && (!input.status || row.status === input.status),
      );
      return c.crmSourceMappingPageSchema.parse({ items: items.slice(0, input.limit), nextCursor: null });
    },
    'outreach.upsertSourceMapping': (raw) => {
      const input = c.crmSourceMappingWriteInputSchema.parse(raw);
      return remember(NITRO, input.requestId, input, () => {
        const prior = mappings.get(input.id);
        if ((prior?.revision ?? 0) !== input.expectedRevision) throw new FixtureError('ops.crm.revision_conflict', 409);
        if (!campaigns.has(input.campaignId)) throw new FixtureError('ops.crm.not_found', 404);
        const { requestId, expectedRevision, reason, ...fields } = input;
        const row = c.crmSourceMappingSchema.parse({
          ...fields,
          revision: expectedRevision + 1,
          createdAt: prior?.createdAt ?? iso(),
          updatedAt: iso(),
        });
        mappings.set(row.id, row);
        audit(input, 'source_mapping', row.id, 'source_mapping_written', NITRO);
        return row;
      });
    },
    'outreach.documentProviderStatus': () =>
      c.crmDocumentProviderStatusSchema.parse({ status: 'disabled', reason: 'api_access_unavailable' }),
    'outreach.listDuplicates': (raw) => {
      const input = c.crmDuplicateListInputSchema.parse(raw);
      const live = [...contacts.values()].filter(({ record }) => !aliases.has(record.id));
      const query = input.query?.toLowerCase();
      const items = live
        .filter(({ record }) => live.filter((other) => other.record.email === record.email).length > 1)
        .filter(({ record }) => !query || record.name.toLowerCase().includes(query) || record.email.includes(query))
        .map(({ record, revision }) => ({
          contact: record,
          revision,
          matchingUnmergedContactCount: live.filter((other) => other.record.email === record.email).length,
        }));
      return c.crmDuplicatePageSchema.parse({ items: items.slice(0, input.limit), nextCursor: null });
    },
    'outreach.mergeContacts': (raw) => {
      const input = c.crmMergeInputSchema.parse(raw);
      return remember(NITRO, input.requestId, input, () => {
        const source = contacts.get(input.sourceContactId);
        const target = contacts.get(input.targetContactId);
        if (!source || !target || aliases.has(source.record.id) || aliases.has(target.record.id))
          throw new FixtureError('ops.crm.not_found', 404);
        if (source.revision !== input.sourceExpectedRevision || target.revision !== input.targetExpectedRevision)
          throw new FixtureError('ops.crm.revision_conflict', 409);
        for (const [from, to] of aliases) if (to === source.record.id) aliases.set(from, target.record.id);
        aliases.set(source.record.id, target.record.id);
        source.revision += 1;
        target.revision += 1;
        target.record = c.crmContactSchema.parse({
          ...target.record,
          interests: [...new Set([...target.record.interests, ...source.record.interests])],
          updatedAt: iso(),
        });
        let moved = 0;
        for (const row of opportunities.values())
          if (row.contactId === source.record.id) {
            saveOpportunity({ ...row, contactId: target.record.id, revision: row.revision + 1 });
            moved += 1;
          }
        audit(input, 'contact', source.record.id, 'contacts_merged', NITRO);
        audit(input, 'contact', target.record.id, 'contacts_merged', NITRO);
        return c.crmMergeReceiptSchema.parse({
          mergeId: randomUUID(),
          sourceContactId: source.record.id,
          targetContactId: target.record.id,
          sourceRevision: source.revision,
          targetRevision: target.revision,
          movedOpportunityCount: moved,
          mergedAt: iso(),
        });
      });
    },
    'outreach.exportSubmissions': (raw) => {
      const input = c.crmExportInputSchema.parse(raw);
      return remember(NITRO, input.requestId, input, () => {
        const exportId = randomUUID();
        const rows = visible().filter((row) => matches(row, input));
        const items = [...new Set(rows.map((row) => row.submissionId))].slice(0, input.limit).map((id) => {
          const saved = submissions.get(id);
          return {
            submission: saved.record,
            initialContact: saved.initialContact,
            firstCompletedAt: saved.firstCompletedAt,
            originalContact: contact(saved.record.contactId),
            canonicalContact: contact(canonical(saved.record.contactId)),
            attribution: noSource(saved.record.capturedAt),
          };
        });
        audit(input, 'export', exportId, 'export_generated', NITRO);
        return c.crmExportPageSchema.parse({ exportId, generatedAt: iso(), items, nextCursor: null });
      });
    },
    'outreach.privacyRetentionStatus': () =>
      c.crmRetentionStatusSchema.parse({
        status: 'configured',
        inactivityCalendarMonths: 6,
        clockTimeZone: 'UTC',
        activeReviewMaxDays: 30,
        automationEnabled: false,
        lastSweepAt: null,
      }),
    'outreach.privacyRetentionReviewStatus': (raw) =>
      reviews.get(c.crmRetentionReviewStatusInputSchema.parse(raw).canonicalContactId) ?? null,
    'outreach.privacyRetentionReview': (raw) => {
      const input = c.crmRetentionReviewInputSchema.parse(raw);
      return remember(NITRO, input.requestId, input, () => {
        const prior = reviews.get(input.canonicalContactId);
        if ((prior?.revision ?? 0) !== input.expectedReviewRevision) throw new FixtureError('ops.crm.revision_conflict', 409);
        const review = c.crmRetentionReviewSchema.parse({
          reviewId: randomUUID(),
          canonicalContactId: input.canonicalContactId,
          revision: input.expectedReviewRevision + 1,
          state: input.state,
          reviewedBy: NITRO,
          reviewedAt: iso(),
          expiresAt: input.state === 'active' ? iso(30 * DAY) : null,
          evidenceRef: input.evidenceRef,
          reason: input.reason,
        });
        reviews.set(input.canonicalContactId, review);
        return review;
      });
    },
    'outreach.privacyPreview': (raw) => {
      const input = c.crmErasurePreviewInputSchema.parse(raw);
      assertContactWritable(input.canonicalContactId);
      const target = contacts.get(input.canonicalContactId);
      if (!target || aliases.has(input.canonicalContactId)) throw new FixtureError('ops.crm.not_found', 404);
      const ids = cluster(input.canonicalContactId);
      const submissionIds = [...submissions.values()].filter((s) => ids.includes(s.record.contactId)).map((s) => s.record.submissionId);
      const opportunityIds = [...opportunities.values()].filter((row) => ids.includes(row.contactId)).map((row) => row.id);
      const preview = {
        canonicalContactId: input.canonicalContactId,
        canonicalRevision: target.revision,
        contacts: ids.map((id) => ({ contactId: id, revision: contacts.get(id).revision })),
        submissionIds,
        counts: {
          contacts: ids.length,
          submissions: submissionIds.length,
          opportunities: opportunityIds.length,
          tasks: tasks.filter((row) => opportunityIds.includes(row.task.opportunityId)).length,
          messages: messages.filter((row) => opportunityIds.includes(row.opportunityId)).length,
        },
      };
      return c.crmErasurePreviewSchema.parse({ ...preview, snapshot: createHash('sha256').update(JSON.stringify(preview)).digest('hex') });
    },
    'outreach.privacyBegin': (raw) => {
      const input = c.crmErasureBeginInputSchema.parse(raw);
      return remember(NITRO, input.requestId, input, () => {
        const preview = founderApi['outreach.privacyPreview']({ canonicalContactId: input.canonicalContactId });
        if (preview.snapshot !== input.snapshot || preview.canonicalRevision !== input.expectedCanonicalRevision)
          throw new FixtureError('ops.crm.erasure_snapshot_changed', 409);
        const ids = cluster(input.canonicalContactId);
        // Like svc-ops createIntent: the request is recorded and records stay in place
        // until every submission's notification erasure is cleared (see privacyAdvance).
        const scope = {
          contactIds: ids,
          submissionIds: preview.submissionIds,
          opportunityIds: [...opportunities.values()].filter((row) => ids.includes(row.contactId)).map((row) => row.id),
          organisationIds: [...new Set(ids.flatMap((id) => contact(id)?.organisationIds ?? []))],
        };
        const status = c.crmErasureStatusSchema.parse({
          intentId: randomUUID(),
          canonicalContactId: input.canonicalContactId,
          revision: 1,
          status: 'pending_notify',
          actorKind: 'founder',
          requestedBy: NITRO,
          requestedAt: iso(),
          completedAt: null,
          pendingSubmissionCount: preview.submissionIds.length,
          code: null,
        });
        erasures.set(status.intentId, status);
        erasureScopes.set(status.intentId, scope);
        return status;
      });
    },
    'outreach.privacyAdvance': (raw) => {
      const input = c.crmErasureAdvanceInputSchema.parse(raw);
      const prior = erasures.get(input.intentId);
      if (!prior) throw new FixtureError('ops.crm.erasure_not_found', 404);
      if (prior.status === 'complete') return prior;
      return remember(NITRO, input.requestId, input, () => {
        const current = erasures.get(input.intentId);
        if (current.revision !== input.expectedRevision) throw new FixtureError('ops.crm.revision_conflict', 409);
        // svc-ops advanceIntent: without the notification link the intent stays pending_notify.
        if (!notifyConfigured) {
          const stuck = c.crmErasureStatusSchema.parse({ ...current, revision: current.revision + 1, code: UNCONFIGURED });
          erasures.set(stuck.intentId, stuck);
          return stuck;
        }
        // One submission notification is cleared per advance; the last one applies the erasure.
        const pendingSubmissionCount = Math.max(0, current.pendingSubmissionCount - 1);
        const done = pendingSubmissionCount === 0;
        const next = c.crmErasureStatusSchema.parse({
          ...current,
          revision: current.revision + 1,
          status: done ? 'complete' : 'pending_notify',
          completedAt: done ? iso() : null,
          pendingSubmissionCount,
          code: null,
        });
        erasures.set(next.intentId, next);
        if (done) applyErasure(erasureScopes.get(next.intentId));
        return next;
      });
    },
    'outreach.privacyStatus': (raw) => {
      const input = c.crmErasureStatusInputSchema.parse(raw);
      const found =
        'intentId' in input
          ? erasures.get(input.intentId)
          : [...erasures.values()].find((row) => row.canonicalContactId === input.canonicalContactId);
      if (!found) throw new FixtureError('ops.crm.erasure_not_found', 404);
      return found;
    },
  };

  // Founder sign-up (/enroll) and Security (/security, /reset). Security's auth.stepUp wins, because its actions spend the
  // step-up it records; the enrolment step-up accepts the same test code. Signing in keeps the preview coherent: the
  // password typed first becomes the test password, and after a change only the new one works.
  const enrolment = fixtureFounderEnrolmentHandlers({});
  const securityState = {};
  const security = fixtureFounderSecurityHandlers(securityState, clock);
  const baseLogin = founderApi['auth.login'];
  const baseLogout = founderApi['auth.logout'];
  Object.assign(founderApi, enrolment, security, {
    'auth.login': (input) => {
      if (securityState.passwordChangedAt && input?.password !== securityState.password) {
        throw new FixtureError('auth.invalid_credentials', 401);
      }
      if (!securityState.passwordChangedAt && typeof input?.password === 'string' && input.password)
        securityState.password = input.password;
      return baseLogin(input);
    },
    'auth.logout': (input) => {
      enrolment['auth.logout'](input);
      return baseLogout(input);
    },
  });

  return { publicApi, founderApi, contacts, opportunities, submissions };
}

/**
 * Seeds the CRM through the same public calls a visitor makes, so every row has
 * a real submission behind it. Names and emails are visibly test data.
 */
export function seedTestEnquiries(fixture) {
  const { publicApi, founderApi } = fixture;
  const token = () => randomUUID().replaceAll('-', '').padEnd(42, 'A').slice(0, 42) + 'A';
  const enquire = (contact, answers) => {
    const continuationToken = token();
    const receipt = publicApi.capture({ requestId: randomUUID(), continuationToken, contact: { marketingOptIn: false, ...contact } });
    let revision = receipt.revision;
    for (const questionnaire of answers) {
      const draft = publicApi.answer({
        requestId: randomUUID(),
        submissionId: receipt.submissionId,
        continuationToken,
        expectedRevision: revision,
        questionnaire: { version: 1, ...questionnaire },
      });
      revision = draft.revision;
    }
    return [...fixture.opportunities.values()].filter((row) => row.submissionId === receipt.submissionId);
  };
  const stage = (opportunity, next, extra = {}) => {
    const current = fixture.opportunities.get(opportunity.id);
    return founderApi['outreach.changeStage']({
      requestId: randomUUID(),
      opportunityId: current.id,
      expectedRevision: current.revision,
      stage: next,
      reason: 'Test data: sample founder review',
      closedDisposition: null,
      closingEvidenceRef: null,
      nextAction: { description: 'Schedule an introduction call', dueAt: new Date(Date.now() + 3 * DAY).toISOString() },
      ...extra,
    });
  };

  const [investorA] = enquire(
    { name: 'Test Investor A', email: 'test.investor.a@example.invalid', country: 'SG', interests: ['investor'] },
    [
      {
        audience: 'investor',
        answers: {
          investorType: 'family_office',
          participation: 'direct',
          decisionRole: 'decision_maker',
          indicativeContribution: { status: 'stated', amount: '250000', currency: 'EUR' },
          timing: 'within_three_months',
          message: 'Test data. Interested in the cash-advance structure; please share the deck.',
        },
      },
    ],
  );
  stage(investorA, 'qualified');
  enquire({ name: 'Test Investor B (introducer)', email: 'test.introducer.b@example.invalid', interests: ['investor'] }, [
    {
      audience: 'investor',
      answers: {
        investorType: 'other',
        participation: 'introduction',
        decisionRole: 'introducer',
        indicativeContribution: { status: 'undecided' },
        timing: 'undecided',
      },
    },
  ]);
  enquire({ name: 'Test Trader', email: 'test.trader@example.invalid', interests: ['trader'] }, [
    {
      audience: 'trader',
      answers: {
        markets: ['spot', 'copy_trading'],
        experience: 'intermediate',
        role: 'individual',
        platformInterest: 'Copy trading',
        timing: 'as_available',
      },
    },
  ]);
  enquire(
    { name: 'Test Merchant', email: 'test.merchant@example.invalid', organisationName: 'Test Merchant Ltd', interests: ['merchant'] },
    [],
  );
  const [academy] = enquire({ name: 'Test Academy Student', email: 'test.academy@example.invalid', interests: ['academy'] }, [
    {
      audience: 'academy',
      answers: {
        learningGoal: 'Learn risk management',
        experience: 'beginner',
        subjects: ['Risk', 'Spot trading'],
        format: 'cohort',
        timing: 'later',
      },
    },
  ]);
  stage(academy, 'invited');
  const [partner] = enquire({ name: 'Test Partner', email: 'test.partner@example.invalid', interests: ['partner'] }, [
    {
      audience: 'partner',
      answers: {
        expertise: 'Payments compliance',
        contribution: 'Test data: advisory support.',
        relationship: 'collaboration',
        timing: 'later',
      },
    },
  ]);
  stage(partner, 'closed', { closedDisposition: 'declined', closingEvidenceRef: 'test-data-note', nextAction: null });
  // Same email as Test Investor A, so the duplicate-merge screen has one real case.
  enquire({ name: 'Test Investor A', email: 'test.investor.a@example.invalid', interests: ['trader'] }, []);
}

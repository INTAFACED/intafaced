/**
 * The preview fixture must answer like svc-ops for the founder CRM changes in wave 2:
 * sent message text, the next-action edit, and search through a merged-away contact.
 * Run: node --test tooling/preview/outreach/fixture.test.mjs   (needs packages/contracts built)
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOutreachFixture, FixtureError, NITRO, PHANTOM } from './fixture.mjs';

const repo = resolve(import.meta.dirname, '../../..');
const dist = join(repo, 'packages/contracts/dist/index.js');
const built = existsSync(dist);

describe('outreach preview fixture, founder CRM wave 2', { skip: built ? false : 'build packages/contracts first' }, async () => {
  const contracts = built ? await import(pathToFileURL(dist).href) : {};
  const token = () => randomUUID().replaceAll('-', '').padEnd(42, 'A').slice(0, 42) + 'A';
  function setup() {
    const fixture = createOutreachFixture(contracts, () => Date.parse('2026-10-14T02:00:00Z'));
    const enquire = (name, email) => {
      const receipt = fixture.publicApi.capture({
        requestId: randomUUID(),
        continuationToken: token(),
        contact: { name, email, interests: ['investor'], marketingOptIn: false },
      });
      return [...fixture.opportunities.values()].find((row) => row.submissionId === receipt.submissionId);
    };
    const f = fixture.founderApi;
    const list = (query) => f['outreach.listOpportunities']({ limit: 50, ...(query ? { query } : {}) });
    const nameOf = (page, row) => page.contacts.find((c) => c.id === row.contactId).name;
    return { fixture, f, enquire, list, nameOf };
  }
  const edit = (opportunity, extra = {}) => ({
    requestId: randomUUID(),
    opportunityId: opportunity.id,
    expectedRevision: opportunity.revision,
    description: 'Send the deck',
    dueAt: '2026-10-16T09:00:00.000Z',
    ...extra,
  });

  it('returns the text a founder queued on the message list and the queue receipt, and keeps it out of the public API', () => {
    const { fixture, f, enquire } = setup();
    const opportunity = enquire('Ada', 'ada@example.invalid');
    const receipt = f['outreach.queueMessage']({
      requestId: randomUUID(),
      opportunityId: opportunity.id,
      expectedRevision: opportunity.revision,
      kind: 'follow_up',
      staffText: 'Are you free on Friday?',
      reason: 'Founder follow-up',
    });
    assert.equal(receipt.message.staffText, 'Are you free on Friday?');
    const page = f['outreach.listMessages']({ opportunityId: opportunity.id, limit: 20 });
    assert.deepEqual(
      page.items.map((m) => m.staffText),
      ['Are you free on Friday?'],
    );
    // Newest first, like svc-ops.
    const second = f['outreach.queueMessage']({
      requestId: randomUUID(),
      opportunityId: opportunity.id,
      expectedRevision: receipt.opportunity.revision,
      kind: 'follow_up',
      staffText: 'Second message',
      reason: 'Founder follow-up',
    });
    assert.deepEqual(
      f['outreach.listMessages']({ opportunityId: opportunity.id, limit: 20 }).items.map((m) => m.staffText),
      ['Second message', 'Are you free on Friday?'],
    );
    assert.equal(second.message.staffText, 'Second message');
    // No public procedure lists messages, and what the public API returns never carries the text.
    assert.deepEqual(Object.keys(fixture.publicApi).sort(), ['addInterests', 'answer', 'capture', 'resume']);
    const token2 = token();
    const publicReceipt = fixture.publicApi.capture({
      requestId: randomUUID(),
      continuationToken: token2,
      contact: { name: 'Public', email: 'public@example.invalid', interests: ['investor'], marketingOptIn: false },
    });
    assert.doesNotMatch(JSON.stringify(publicReceipt), /staffText/);
    assert.doesNotMatch(
      JSON.stringify(fixture.publicApi.resume({ submissionId: publicReceipt.submissionId, continuationToken: token2 })),
      /staffText/,
    );
  });

  it('edits only the next action: same stage and owner, one revision on, replaced task, its own history entry', () => {
    const { f, enquire } = setup();
    const opportunity = enquire('Ada', 'ada@example.invalid');
    const body = edit(opportunity);
    const saved = f['outreach.updateNextAction'](body);
    assert.equal(saved.stage, opportunity.stage);
    assert.equal(saved.ownerUserId, opportunity.ownerUserId);
    assert.equal(saved.revision, opportunity.revision + 1);
    assert.deepEqual(saved.nextAction, { description: 'Send the deck', dueAt: '2026-10-16T09:00:00.000Z' });
    // The same request replays; a different body under the same request id conflicts.
    assert.deepEqual(f['outreach.updateNextAction'](body), saved);
    assert.throws(
      () => f['outreach.updateNextAction']({ ...body, description: 'Other' }),
      (e) => e.code === 'ops.crm.idempotency_conflict',
    );
    const detail = f['outreach.getOpportunity']({ opportunityId: opportunity.id });
    const pending = detail.tasks.filter((t) => t.status === 'pending');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].description, 'Send the deck');
    assert.equal(pending[0].dueAt, '2026-10-16T09:00:00.000Z');
    assert.equal(detail.tasks.filter((t) => t.status === 'cancelled').length, 1);
    const entries = detail.activities.filter((a) => a.kind === 'next_action_changed');
    assert.equal(entries.length, 1);
    assert.deepEqual(
      { note: entries[0].note, referenceId: entries[0].referenceId, actor: entries[0].actor },
      { note: 'Send the deck', referenceId: '2026-10-16T09:00:00.000Z', actor: { kind: 'operator', userId: NITRO } },
    );
    assert.equal(detail.activities.filter((a) => a.kind === 'stage_changed').length, 0);
  });

  it('refuses a stale revision, an unknown enquiry, a closed enquiry, a stage field and a reason', () => {
    const { f, enquire } = setup();
    const opportunity = enquire('Ada', 'ada@example.invalid');
    const saved = f['outreach.updateNextAction'](edit(opportunity));
    assert.throws(
      () => f['outreach.updateNextAction'](edit(opportunity, { description: 'Stale' })),
      (e) => e instanceof FixtureError && e.code === 'ops.crm.revision_conflict' && e.status === 409,
    );
    assert.throws(
      () => f['outreach.updateNextAction'](edit({ id: randomUUID(), revision: 1 })),
      (e) => e instanceof FixtureError && e.status === 404,
    );
    assert.throws(
      () => f['outreach.updateNextAction'](edit(saved, { stage: 'closed' })),
      (e) => e.name === 'ZodError',
    );
    assert.throws(
      () => f['outreach.updateNextAction'](edit(saved, { reason: 'Because' })),
      (e) => e.name === 'ZodError',
    );
    const closed = f['outreach.changeStage']({
      requestId: randomUUID(),
      opportunityId: saved.id,
      expectedRevision: saved.revision,
      stage: 'closed',
      reason: 'Declined',
      closedDisposition: 'declined',
      closingEvidenceRef: 'note',
      nextAction: null,
    });
    assert.throws(
      () => f['outreach.updateNextAction'](edit(closed)),
      (e) => e instanceof FixtureError && e.code === 'ops.crm.opportunity_closed',
    );
  });

  it('moves the replacement task to the current owner and records the same audit trail as svc-ops', () => {
    const { f, enquire } = setup();
    const opportunity = enquire('Ada', 'ada@example.invalid');
    const reassigned = f['outreach.assign']({
      requestId: randomUUID(),
      opportunityId: opportunity.id,
      expectedRevision: opportunity.revision,
      ownerUserId: PHANTOM,
    });
    const saved = f['outreach.updateNextAction'](edit(reassigned));
    const pending = f['outreach.listTasks']({ limit: 20, opportunityId: saved.id, status: 'pending' }).items;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].task.ownerUserId, PHANTOM);
    const audits = f['outreach.listWorkflowAudit']({ subjectType: 'task', subjectId: pending[0].task.id, limit: 10 }).items;
    assert.deepEqual(
      audits.map((a) => a.kind),
      ['task_created'],
    );
  });

  it('finds a merged-away contact by its old name or email, and names it only when the visible contact does not match', () => {
    const { f, enquire, list, nameOf } = setup();
    const keep = enquire('Ada Lovelace', 'ada@example.invalid');
    const gone = enquire('Augusta Byron', 'augusta@old.example.invalid');
    enquire('Grace Hopper', 'grace@example.invalid');
    const contactOf = (row) => f['outreach.getContactProvenance']({ contactId: row.contactId }).canonicalContact;
    const [target, source] = [contactOf(keep), contactOf(gone)];
    f['outreach.mergeContacts']({
      requestId: randomUUID(),
      sourceContactId: source.id,
      targetContactId: target.id,
      sourceExpectedRevision: 1,
      targetExpectedRevision: 1,
      confirmed: true,
      reason: 'Founder confirmed one person',
    });
    // Both enquiries now sit under the surviving contact; the old name lives only on the merged-away one.
    const old = list('augusta');
    assert.deepEqual(
      old.items.map((row) => nameOf(old, row)),
      ['Ada Lovelace', 'Ada Lovelace'],
    );
    assert.deepEqual(
      [...old.aliasMatches].sort((a, b) => a.opportunityId.localeCompare(b.opportunityId)),
      old.items
        .map((row) => ({ opportunityId: row.id, name: 'Augusta Byron' }))
        .sort((a, b) => a.opportunityId.localeCompare(b.opportunityId)),
    );
    const byEmail = list('AUGUSTA@OLD');
    assert.equal(byEmail.items.length, 2);
    assert.equal(byEmail.aliasMatches.length, 2);
    // A match on the visible contact is direct: no "also". Unrelated and empty searches carry nothing.
    assert.equal(list('lovelace').items.length, 2);
    assert.equal(list('lovelace').aliasMatches, undefined);
    assert.equal(list('hopper').aliasMatches, undefined);
    assert.equal(list('zzz-nobody').items.length, 0);
    assert.equal(list().aliasMatches, undefined);
    assert.equal(list('%').items.length, 0);
  });

  it('does not find or name a merged-away contact once its cluster is under erasure (pending_notify)', () => {
    const { f, enquire, list } = setup();
    const keep = enquire('Yara Keep', 'yara@example.invalid');
    const gone = enquire('Zelda Old', 'zelda@old.example.invalid');
    const contactOf = (row) => f['outreach.getContactProvenance']({ contactId: row.contactId }).canonicalContact;
    const [target, source] = [contactOf(keep), contactOf(gone)];
    f['outreach.mergeContacts']({
      requestId: randomUUID(),
      sourceContactId: source.id,
      targetContactId: target.id,
      sourceExpectedRevision: 1,
      targetExpectedRevision: 1,
      confirmed: true,
      reason: 'Founder confirmed one person',
    });
    assert.equal(list('zelda').items.length, 2);
    assert.equal(list('zelda').aliasMatches.length, 2);
    const preview = f['outreach.privacyPreview']({ canonicalContactId: target.id });
    const intent = f['outreach.privacyBegin']({
      requestId: randomUUID(),
      canonicalContactId: preview.canonicalContactId,
      expectedCanonicalRevision: preview.canonicalRevision,
      snapshot: preview.snapshot,
      confirmedEntireCluster: true,
      reason: 'confirmed_privacy_request',
    });
    assert.equal(intent.status, 'pending_notify');
    const page = list('zelda');
    assert.equal(page.items.length, 0);
    assert.equal(page.aliasMatches, undefined);
  });

  it('every reply it gives is parsed with the shared contract', () => {
    const { f, enquire, list } = setup();
    const opportunity = enquire('Ada', 'ada@example.invalid');
    const saved = f['outreach.updateNextAction'](edit(opportunity));
    assert.ok(contracts.crmOpportunitySchema.safeParse(saved).success);
    assert.ok(contracts.crmOpportunityPageSchema.safeParse(list('ada')).success);
    assert.ok(contracts.crmActivitySchema.safeParse(f['outreach.getOpportunity']({ opportunityId: saved.id }).activities.at(-1)).success);
  });
});

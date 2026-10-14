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

describe('outreach preview fixture, founder inbox', { skip: built ? false : 'build packages/contracts first' }, async () => {
  const contracts = built ? await import(pathToFileURL(dist).href) : {};
  const { seedTestEnquiries } = await import('./fixture.mjs');
  const token = () => randomUUID().replaceAll('-', '').padEnd(42, 'A').slice(0, 42) + 'A';
  const HOUR = 3_600_000;
  const T0 = Date.parse('2026-10-14T00:00:00Z');
  function setup() {
    let now = T0;
    const fixture = createOutreachFixture(contracts, () => now);
    const f = fixture.founderApi;
    const enquire = (audience = 'investor', stated, participation = 'direct', email) => {
      const continuationToken = token();
      const receipt = fixture.publicApi.capture({
        requestId: randomUUID(),
        continuationToken,
        contact: {
          name: `Person ${fixture.opportunities.size}`,
          email: email ?? `p${fixture.opportunities.size}@example.invalid`,
          interests: [audience],
          marketingOptIn: false,
        },
      });
      if (audience === 'investor' && stated !== undefined)
        fixture.publicApi.answer({
          requestId: randomUUID(),
          submissionId: receipt.submissionId,
          continuationToken,
          expectedRevision: 1,
          questionnaire: {
            audience: 'investor',
            version: 1,
            answers: {
              investorType: 'individual',
              participation,
              decisionRole: 'decision_maker',
              indicativeContribution: stated === 'undecided' ? { status: 'undecided' } : { status: 'stated', ...stated },
              timing: 'undecided',
            },
          },
        });
      return [...fixture.opportunities.values()].find((row) => row.submissionId === receipt.submissionId);
    };
    const fresh = (opportunity) => fixture.opportunities.get(opportunity.id);
    const reply = (opportunity, extra = {}) =>
      f['outreach.recordInteraction']({
        requestId: randomUUID(),
        opportunityId: opportunity.id,
        expectedRevision: fresh(opportunity).revision,
        kind: 'reply_sent',
        occurredAt: new Date(now).toISOString(),
        nextAction: { description: 'Check in', dueAt: new Date(now + 24 * HOUR).toISOString() },
        reason: 'Replied from Gmail',
        ...extra,
      });
    const commit = (opportunity, commitment) =>
      f['outreach.setCommitment']({
        requestId: randomUUID(),
        opportunityId: opportunity.id,
        expectedRevision: fresh(opportunity).revision,
        // Committed means documented agreements, so the reference is required; tests not about that supply one.
        commitment:
          commitment?.tier === 'committed' && commitment.evidenceRef === undefined
            ? { ...commitment, evidenceRef: 'signed agreement' }
            : commitment,
        reason: 'After the call',
      });
    return { fixture, f, enquire, fresh, reply, commit, advance: (hours) => (now += hours * HOUR), clock: () => now };
  }
  const throwsCode = (code) => (e) => e.code === code;

  it('derives first reply, last touch and waiting since like svc-ops, and notes and owner changes are not touches', () => {
    const { f, enquire, fresh, reply, advance } = setup();
    const opportunity = enquire();
    const read = () => f['outreach.getOpportunity']({ opportunityId: opportunity.id }).opportunity;
    assert.deepEqual(
      { first: read().firstReplyAt, last: read().lastTouchAt, since: read().waitingSince },
      { first: null, last: null, since: opportunity.createdAt },
    );
    advance(1);
    f['outreach.addNote']({ requestId: randomUUID(), opportunityId: opportunity.id, note: 'Looks serious' });
    f['outreach.assign']({
      requestId: randomUUID(),
      opportunityId: opportunity.id,
      expectedRevision: fresh(opportunity).revision,
      ownerUserId: PHANTOM,
    });
    assert.equal(read().lastTouchAt, null);
    advance(1);
    f['outreach.changeStage']({
      requestId: randomUUID(),
      opportunityId: opportunity.id,
      expectedRevision: fresh(opportunity).revision,
      stage: 'qualified',
      reason: 'Reviewed: fits',
      closedDisposition: null,
      closingEvidenceRef: null,
      nextAction: { description: 'Call', dueAt: new Date(T0 + 72 * HOUR).toISOString() },
    });
    assert.deepEqual(
      { first: read().firstReplyAt, last: read().lastTouchAt },
      { first: null, last: new Date(T0 + 2 * HOUR).toISOString() },
    );
    advance(1);
    const receipt = reply(opportunity);
    assert.equal(receipt.interaction.kind, 'reply_sent');
    assert.equal(receipt.interaction.evidenceRef, null);
    assert.equal(receipt.activity.kind, 'reply_sent');
    const now3 = new Date(T0 + 3 * HOUR).toISOString();
    assert.deepEqual(
      { first: read().firstReplyAt, last: read().lastTouchAt, since: read().waitingSince },
      { first: now3, last: now3, since: new Date(T0 + 27 * HOUR).toISOString() },
    );
  });

  it('counts a queued message as the first reply, and a follow-up interaction as a touch only', () => {
    const { f, enquire, fresh, advance } = setup();
    const opportunity = enquire();
    advance(1);
    f['outreach.recordInteraction']({
      requestId: randomUUID(),
      opportunityId: opportunity.id,
      expectedRevision: fresh(opportunity).revision,
      kind: 'follow_up',
      occurredAt: new Date(T0 + HOUR).toISOString(),
      evidenceRef: 'note-1',
      nextAction: { description: 'Try again', dueAt: new Date(T0 + 30 * HOUR).toISOString() },
      reason: 'Internal chase',
    });
    const read = () => f['outreach.getOpportunity']({ opportunityId: opportunity.id }).opportunity;
    assert.deepEqual({ first: read().firstReplyAt, last: read().lastTouchAt }, { first: null, last: new Date(T0 + HOUR).toISOString() });
    advance(1);
    f['outreach.queueMessage']({
      requestId: randomUUID(),
      opportunityId: opportunity.id,
      expectedRevision: fresh(opportunity).revision,
      kind: 'information_request',
      staffText: 'Could you share your timing?',
      reason: 'Founder follow-up',
    });
    assert.deepEqual(
      { first: read().firstReplyAt, last: read().lastTouchAt },
      { first: new Date(T0 + 2 * HOUR).toISOString(), last: new Date(T0 + 2 * HOUR).toISOString() },
    );
  });

  it('refuses a reply_sent on a closed enquiry, in the future, with a stale revision, or with a repeated evidence reference', () => {
    const { f, enquire, fresh, reply, advance } = setup();
    const opportunity = enquire();
    advance(1);
    reply(opportunity, { evidenceRef: 'gmail-1' });
    assert.throws(() => reply(opportunity, { evidenceRef: 'gmail-1' }), throwsCode('ops.crm.interaction_already_recorded'));
    reply(opportunity);
    reply(opportunity);
    assert.throws(() => reply(opportunity, { expectedRevision: 1 }), throwsCode('ops.crm.revision_conflict'));
    assert.throws(
      () => reply(opportunity, { occurredAt: new Date(T0 + 9 * HOUR).toISOString() }),
      throwsCode('ops.crm.interaction_in_future'),
    );
    assert.throws(
      () => reply(opportunity, { reason: undefined }),
      (e) => e.name === 'ZodError',
    );
    assert.throws(
      () => reply(opportunity, { nextAction: undefined }),
      (e) => e.name === 'ZodError',
    );
    assert.throws(
      () => reply(opportunity, { kind: 'follow_up' }),
      (e) => e.name === 'ZodError',
    );
    f['outreach.changeStage']({
      requestId: randomUUID(),
      opportunityId: opportunity.id,
      expectedRevision: fresh(opportunity).revision,
      stage: 'closed',
      reason: 'No',
      closedDisposition: 'declined',
      closingEvidenceRef: 'note',
      nextAction: null,
    });
    assert.throws(() => reply(opportunity), throwsCode('ops.crm.opportunity_closed'));
  });

  it('serves the waiting queue: open, unreplied or due now, oldest waiting first, each row with waitingSince, paged by cursor', () => {
    const { f, enquire, reply, advance, fixture } = setup();
    const a = enquire(); // unreplied since 0h
    advance(1);
    const b = enquire(); // unreplied since 1h
    advance(1);
    const c = enquire();
    reply(c, { nextAction: { description: 'Check in', dueAt: new Date(T0 + 30 * HOUR).toISOString() } }); // not due yet
    advance(1);
    const d = enquire();
    reply(d, { nextAction: { description: 'Check in', dueAt: new Date(T0 + 4 * HOUR).toISOString() } }); // due at 4h
    const e = enquire();
    f['outreach.changeStage']({
      requestId: randomUUID(),
      opportunityId: e.id,
      expectedRevision: e.revision,
      stage: 'closed',
      reason: 'No',
      closedDisposition: 'declined',
      closingEvidenceRef: 'note',
      nextAction: null,
    });
    const g = enquire('trader');
    advance(1);
    const page = f['outreach.listOpportunities']({ limit: 50, queue: 'waiting' });
    assert.deepEqual(
      page.items.map((item) => [item.id, item.waitingSince]),
      [
        [a.id, a.createdAt],
        [b.id, b.createdAt],
        [g.id, g.createdAt],
        [d.id, new Date(T0 + 4 * HOUR).toISOString()],
      ],
    );
    assert.equal(
      page.items.some((item) => [c.id, e.id].includes(item.id)),
      false,
    );
    assert.ok(contracts.crmOpportunityPageSchema.safeParse(page).success);
    // Paging neither skips nor repeats.
    const seen = [];
    let cursor;
    for (let guard = 0; guard < 10; guard += 1) {
      const next = f['outreach.listOpportunities']({ limit: 1, queue: 'waiting', ...(cursor ? { cursor } : {}) });
      seen.push(...next.items.map((item) => item.id));
      if (next.nextCursor === null) break;
      cursor = next.nextCursor;
    }
    assert.deepEqual(
      seen,
      page.items.map((item) => item.id),
    );
    // The default listing is unchanged (newest first, everything) and carries reply state too.
    const all = f['outreach.listOpportunities']({ limit: 50 });
    assert.equal(all.items.length, fixture.opportunities.size);
    assert.ok(all.items.every((item) => 'waitingSince' in item && 'firstReplyAt' in item && 'lastTouchAt' in item));
    // Filters combine with the queue, and a cursor does not cross modes.
    assert.deepEqual(
      f['outreach.listOpportunities']({ limit: 50, queue: 'waiting', audience: 'trader' }).items.map((item) => item.id),
      [g.id],
    );
    assert.throws(() => f['outreach.listOpportunities']({ limit: 1, cursor: cursor ?? 'x' }), throwsCode('ops.crm.cursor_invalid'));
    assert.throws(
      () => f['outreach.listOpportunities']({ limit: 1, queue: 'waiting', cursor: 'not-a-cursor' }),
      throwsCode('ops.crm.cursor_invalid'),
    );
    assert.throws(
      () => f['outreach.listOpportunities']({ limit: 1, queue: 'overdue' }),
      (error) => error.name === 'ZodError',
    );
    // When the promised check-in falls due the enquiry is waiting again.
    advance(30);
    assert.ok(f['outreach.listOpportunities']({ limit: 50, queue: 'waiting' }).items.some((item) => item.id === c.id));
  });

  it('sets, replays and clears a commitment: investors only, revision-checked, audited, exact', () => {
    const { f, enquire, fresh, commit, advance } = setup();
    const investor = enquire('investor', { amount: '250000', currency: 'EUR' });
    advance(1);
    const exact = '12345678901234567890.123456789012345678';
    const requestId = randomUUID();
    const input = {
      requestId,
      opportunityId: investor.id,
      expectedRevision: fresh(investor).revision,
      commitment: { tier: 'soft_circled', amount: exact, currency: 'EUR', evidenceRef: 'call notes' },
      reason: 'After the call',
    };
    const saved = f['outreach.setCommitment'](input);
    assert.equal(saved.revision, input.expectedRevision + 1);
    assert.deepEqual(saved.commitment, {
      ...input.commitment,
      recordedAt: new Date(T0 + HOUR).toISOString(),
      recordedBy: NITRO,
    });
    assert.deepEqual(f['outreach.setCommitment'](input), saved);
    assert.throws(
      () => f['outreach.setCommitment']({ ...input, commitment: { ...input.commitment, amount: '1' } }),
      throwsCode('ops.crm.idempotency_conflict'),
    );
    // The enquirer's own amount is untouched.
    assert.deepEqual(saved.indicativeContribution, { status: 'stated', amount: '250000', currency: 'EUR' });
    const detail = f['outreach.getOpportunity']({ opportunityId: investor.id });
    const change = detail.activities.find((a) => a.kind === 'commitment_changed');
    assert.deepEqual([change.fromCommitment, change.toCommitment], [null, { tier: 'soft_circled', amount: exact, currency: 'EUR' }]);
    const audits = f['outreach.listWorkflowAudit']({ subjectType: 'opportunity', subjectId: investor.id, limit: 10 }).items;
    assert.ok(audits.some((a) => a.kind === 'commitment_changed' && a.requestId === requestId && a.actorUserId === NITRO));
    assert.equal(commit(investor, null).commitment, null);
  });

  it('refuses a commitment on other audiences, a stale revision, bad money and an unknown currency', () => {
    const { f, enquire, fresh, commit } = setup();
    const trader = enquire('trader');
    assert.throws(
      () => commit(trader, { tier: 'committed', amount: '100', currency: 'EUR' }),
      throwsCode('ops.crm.commitment_investor_only'),
    );
    assert.throws(() => commit(trader, null), throwsCode('ops.crm.commitment_investor_only'));
    const investor = enquire('investor');
    const ok = { tier: 'committed', amount: '100', currency: 'EUR', evidenceRef: 'signed' };
    assert.throws(
      () =>
        f['outreach.setCommitment']({
          requestId: randomUUID(),
          opportunityId: investor.id,
          expectedRevision: 9,
          commitment: ok,
          reason: 'x',
        }),
      throwsCode('ops.crm.revision_conflict'),
    );
    for (const amount of ['-1', '1e3', '1,000', '0', '', 'ten', 100])
      assert.throws(
        () => commit(investor, { ...ok, amount }),
        (e) => e.name === 'ZodError',
        String(amount),
      );
    for (const currency of ['ZZZ', 'XXX', 'BTC', 'eur', 'EURO'])
      assert.throws(
        () => commit(investor, { ...ok, currency }),
        (e) => e.name === 'ZodError',
        currency,
      );
    assert.throws(
      () => commit(investor, { ...ok, tier: 'received' }),
      (e) => e.name === 'ZodError',
    );
    assert.throws(
      () =>
        f['outreach.setCommitment']({
          requestId: randomUUID(),
          opportunityId: investor.id,
          expectedRevision: fresh(investor).revision,
          commitment: ok,
        }),
      (e) => e.name === 'ZodError',
    );
    assert.equal(fresh(investor).commitment, null);
  });

  it('totals the raise per currency with exact decimals and never counts anyone at two levels', () => {
    const { f, enquire, commit, fresh } = setup();
    enquire('investor', { amount: '250000', currency: 'EUR' });
    enquire('investor', { amount: '100000.50', currency: 'EUR' });
    enquire('investor', { amount: '50000', currency: 'USD' });
    enquire('investor');
    const stated = enquire('investor', { amount: '1000', currency: 'EUR' });
    commit(stated, { tier: 'soft_circled', amount: '300', currency: 'EUR' });
    enquire('trader');
    for (const [amount, currency] of [
      ['0.1', 'EUR'],
      ['0.2', 'EUR'],
      ['9007199254740993', 'USD'],
      ['1', 'USD'],
    ])
      commit(enquire('investor'), { tier: 'committed', amount, currency });
    const closed = enquire('investor', { amount: '700', currency: 'EUR' });
    f['outreach.changeStage']({
      requestId: randomUUID(),
      opportunityId: closed.id,
      expectedRevision: fresh(closed).revision,
      stage: 'closed',
      reason: 'No',
      closedDisposition: 'declined',
      closingEvidenceRef: 'note',
      nextAction: null,
    });
    const metrics = f['outreach.metrics']({});
    assert.deepEqual(metrics.raise, {
      indicated: [
        { currency: 'EUR', amount: '350000.5' },
        { currency: 'USD', amount: '50000' },
      ],
      softCircled: [{ currency: 'EUR', amount: '300' }],
      committed: [
        { currency: 'EUR', amount: '0.3' },
        { currency: 'USD', amount: '9007199254740994' },
      ],
      counts: { indicated: 3, softCircled: 1, committed: 4, undecided: 1 },
    });
    assert.ok(contracts.crmMetricsSchema.safeParse(metrics).success);
    assert.deepEqual(f['outreach.metrics']({ audience: 'trader' }).raise.indicated, []);
  });

  it('records from and to on stage changes and next-action edits', () => {
    const { f, enquire, fresh } = setup();
    const opportunity = enquire();
    f['outreach.changeStage']({
      requestId: randomUUID(),
      opportunityId: opportunity.id,
      expectedRevision: opportunity.revision,
      stage: 'qualified',
      reason: 'Reviewed: fits',
      closedDisposition: null,
      closingEvidenceRef: null,
      nextAction: { description: 'Call', dueAt: '2026-10-16T09:00:00.000Z' },
    });
    f['outreach.updateNextAction']({
      requestId: randomUUID(),
      opportunityId: opportunity.id,
      expectedRevision: fresh(opportunity).revision,
      description: 'Call on Friday',
      dueAt: '2026-10-17T09:00:00.000Z',
    });
    const { activities } = f['outreach.getOpportunity']({ opportunityId: opportunity.id });
    assert.deepEqual((({ fromStage, toStage }) => ({ fromStage, toStage }))(activities.find((a) => a.kind === 'stage_changed')), {
      fromStage: 'new',
      toStage: 'qualified',
    });
    assert.deepEqual((({ fromDueAt, toDueAt }) => ({ fromDueAt, toDueAt }))(activities.find((a) => a.kind === 'next_action_changed')), {
      fromDueAt: '2026-10-16T09:00:00.000Z',
      toDueAt: '2026-10-17T09:00:00.000Z',
    });
    assert.ok(activities.every((a) => contracts.crmActivitySchema.safeParse(a).success));
  });

  it('seeds one soft-circled EUR 250,000 and one committed EUR 100,000 investor, labelled test data', () => {
    const fixture = createOutreachFixture(contracts);
    seedTestEnquiries(fixture);
    const investors = [...fixture.opportunities.values()].filter((row) => row.audience === 'investor' && row.commitment);
    const named = investors.map((row) => ({
      who: fixture.contacts.get(row.contactId).record.name,
      tier: row.commitment.tier,
      amount: row.commitment.amount,
      currency: row.commitment.currency,
      evidence: row.commitment.evidenceRef,
    }));
    assert.deepEqual(
      named.sort((a, b) => a.tier.localeCompare(b.tier)),
      [
        {
          who: 'Test Investor B',
          tier: 'committed',
          amount: '100000',
          currency: 'EUR',
          evidence: 'Test data: sample signed agreement',
        },
        { who: 'Test Investor A', tier: 'soft_circled', amount: '250000', currency: 'EUR', evidence: 'Test data: sample call note' },
      ],
    );
    // CONT:40: nobody who only introduces others is given a contribution.
    for (const row of investors) {
      const answers = fixture.submissions.get(row.submissionId).record.questionnaires[0].answers;
      assert.notEqual(answers.participation, 'introduction');
    }
    const raise = fixture.founderApi['outreach.metrics']({}).raise;
    assert.deepEqual(raise.softCircled, [{ currency: 'EUR', amount: '250000' }]);
    assert.deepEqual(raise.committed, [{ currency: 'EUR', amount: '100000' }]);
    assert.deepEqual(raise.indicated, [{ currency: 'USD', amount: '50000' }]);
    // The queue is not empty and not everything: some replied, some did not.
    const queue = fixture.founderApi['outreach.listOpportunities']({ limit: 50, queue: 'waiting' }).items;
    const all = fixture.founderApi['outreach.listOpportunities']({ limit: 50 }).items;
    assert.ok(queue.length > 0 && queue.length < all.length);
  });
  it('does not count a message whose delivery failed as a reply or a touch', () => {
    const { f, fixture, enquire, fresh, advance } = setup();
    const opportunity = enquire();
    advance(1);
    f['outreach.queueMessage']({
      requestId: randomUUID(),
      opportunityId: opportunity.id,
      expectedRevision: fresh(opportunity).revision,
      kind: 'information_request',
      staffText: 'Could you share your timing?',
      reason: 'Founder follow-up',
    });
    const read = () => f['outreach.getOpportunity']({ opportunityId: opportunity.id }).opportunity;
    assert.equal(read().firstReplyAt, new Date(T0 + HOUR).toISOString());
    fixture.messages[0].status = 'failed';
    assert.deepEqual(
      { first: read().firstReplyAt, last: read().lastTouchAt, since: read().waitingSince },
      { first: null, last: null, since: opportunity.createdAt },
    );
    fixture.messages[0].status = 'unresolved';
    assert.equal(read().firstReplyAt, new Date(T0 + HOUR).toISOString());
  });

  it('requires a reference to the documents for committed, and not for soft-circled', () => {
    const { f, enquire, fresh } = setup();
    const investor = enquire();
    const base = () => ({
      requestId: randomUUID(),
      opportunityId: investor.id,
      expectedRevision: fresh(investor).revision,
      reason: 'Documents signed',
    });
    assert.throws(
      () => f['outreach.setCommitment']({ ...base(), commitment: { tier: 'committed', amount: '5', currency: 'EUR' } }),
      (e) => e.name === 'ZodError',
    );
    assert.equal(fresh(investor).commitment, null);
    assert.equal(
      f['outreach.setCommitment']({ ...base(), commitment: { tier: 'soft_circled', amount: '5', currency: 'EUR' } }).commitment.tier,
      'soft_circled',
    );
  });

  it('refuses a commitment for an introduction-only investor, allows direct, both and unanswered, and still allows clearing', () => {
    const { f, enquire, fresh, commit } = setup();
    const ask = { tier: 'soft_circled', amount: '5', currency: 'EUR' };
    const introducer = enquire('investor', 'undecided', 'introduction');
    assert.throws(() => commit(introducer, ask), throwsCode('ops.crm.commitment_introduction_only'));
    assert.equal(fresh(introducer).commitment, null);
    assert.equal(commit(introducer, null).commitment, null);
    for (const participation of ['direct', 'both'])
      assert.equal(commit(enquire('investor', 'undecided', participation), ask).commitment.tier, 'soft_circled');
    assert.equal(commit(enquire('investor'), ask).commitment.tier, 'soft_circled');
    assert.ok(f['outreach.setCommitment']);
  });

  it('lets the raise label any three-letter currency, survive more than 60 currencies and sum past one amount', () => {
    const { f, enquire } = setup();
    for (const currency of ['XCG', 'BTC', 'HRK', 'ZZZ']) enquire('investor', { amount: '5', currency });
    const code = (i) => String.fromCharCode(65 + (i % 26), 65 + (Math.floor(i / 26) % 26), 66);
    for (let i = 0; i < 62; i += 1) enquire('investor', { amount: '1', currency: code(i) });
    const big = '999999999999999.999999999999999999';
    for (let i = 0; i < 3; i += 1) enquire('investor', { amount: big, currency: 'EUR' });
    const raise = f['outreach.metrics']({}).raise;
    assert.equal(raise.indicated.length, 67);
    assert.equal(raise.indicated.find((t) => t.currency === 'EUR').amount, '2999999999999999.999999999999999997');
    assert.equal(raise.indicated.find((t) => t.currency === 'XCG').amount, '5');
    assert.ok(contracts.crmMetricsSchema.safeParse(f['outreach.metrics']({})).success);
    assert.throws(
      () => enquire('investor', { amount: '1000000000000000', currency: 'EUR' }),
      (e) => e.name === 'ZodError',
    );
  });

  it('counts each person once, at their highest level and by their most recent enquiry', () => {
    const { f, fixture, enquire, commit, advance } = setup();
    const older = enquire('investor', { amount: '100', currency: 'EUR' }, 'direct', 'same@example.invalid');
    advance(1);
    const newer = enquire('investor', { amount: '200', currency: 'EUR' }, 'direct', 'same@example.invalid');
    enquire('investor', { amount: '10', currency: 'EUR' });
    assert.equal(f['outreach.metrics']({}).raise.counts.indicated, 3);
    f['outreach.mergeContacts']({
      requestId: randomUUID(),
      sourceContactId: newer.contactId,
      targetContactId: older.contactId,
      sourceExpectedRevision: 1,
      targetExpectedRevision: 1,
      confirmed: true,
      reason: 'Same person',
    });
    assert.deepEqual((({ indicated, counts }) => ({ indicated, counts: counts.indicated }))(f['outreach.metrics']({}).raise), {
      indicated: [{ currency: 'EUR', amount: '210' }],
      counts: 2,
    });
    commit(fixture.opportunities.get(older.id), { tier: 'soft_circled', amount: '50', currency: 'EUR' });
    assert.deepEqual(f['outreach.metrics']({}).raise, {
      indicated: [{ currency: 'EUR', amount: '10' }],
      softCircled: [{ currency: 'EUR', amount: '50' }],
      committed: [],
      counts: { indicated: 1, softCircled: 1, committed: 0, undecided: 0 },
    });
  });

  it('stores the next action to the millisecond and walks the queue one row at a time without looping', () => {
    const { f, enquire, fresh, advance } = setup();
    const rows = [enquire(), enquire(), enquire()];
    advance(5);
    ['2026-10-14T01:00:00.1231Z', '2026-10-14T01:00:00.1235Z', '2026-10-14T01:00:00.1239Z'].forEach((dueAt, i) =>
      f['outreach.recordInteraction']({
        requestId: randomUUID(),
        opportunityId: rows[i].id,
        expectedRevision: fresh(rows[i]).revision,
        kind: 'reply_sent',
        occurredAt: new Date(T0 + HOUR).toISOString(),
        nextAction: { description: 'Check in', dueAt },
        reason: 'Replied',
      }),
    );
    assert.equal(fresh(rows[0]).nextAction.dueAt, '2026-10-14T01:00:00.123Z');
    const seen = [];
    let cursor;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = f['outreach.listOpportunities']({ limit: 1, queue: 'waiting', ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((item) => item.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    assert.deepEqual(
      seen,
      f['outreach.listOpportunities']({ limit: 50, queue: 'waiting' }).items.map((item) => item.id),
    );
    assert.equal(seen.length, 3);
    assert.equal(new Set(seen).size, 3);
  });

  it('pages the default listing by its own cursor, and refuses a malformed or foreign cursor, like svc-ops', () => {
    const { f, enquire, advance } = setup();
    const made = [];
    for (let i = 0; i < 5; i += 1) {
      made.push(enquire().id);
      advance(1);
    }
    const everything = f['outreach.listOpportunities']({ limit: 50 }).items.map((item) => item.id);
    assert.equal(everything.length, 5);
    const seen = [];
    let cursor;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = f['outreach.listOpportunities']({ limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((item) => item.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    assert.deepEqual(seen, everything);
    const queueCursor = f['outreach.listOpportunities']({ limit: 1, queue: 'waiting' }).nextCursor;
    assert.ok(queueCursor);
    assert.throws(() => f['outreach.listOpportunities']({ limit: 1, cursor: queueCursor }), throwsCode('ops.crm.cursor_invalid'));
    assert.throws(() => f['outreach.listOpportunities']({ limit: 1, queue: 'waiting', cursor }), throwsCode('ops.crm.cursor_invalid'));
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const good = { at: '2026-10-14T00:00:00.000Z', id: made[0] };
    for (const bad of [
      { ...good, extra: 1 },
      { at: 'yesterday', id: made[0] },
      { at: good.at, id: 'not-a-uuid' },
      { at: good.at },
      [],
      'x',
    ])
      assert.throws(() => f['outreach.listOpportunities']({ limit: 1, cursor: encode(bad) }), throwsCode('ops.crm.cursor_invalid'));
    assert.throws(
      () => f['outreach.listOpportunities']({ limit: 1, queue: 'waiting', cursor: encode({ ...good, queue: 'waiting', extra: 1 }) }),
      throwsCode('ops.crm.cursor_invalid'),
    );
    assert.throws(
      () => f['outreach.listOpportunities']({ limit: 1, queue: 'waiting', cursor: encode(good) }),
      throwsCode('ops.crm.cursor_invalid'),
    );
  });
});

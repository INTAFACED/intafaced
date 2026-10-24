import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryGroupBook } from './desk-groups.js';
import { MemoryPropertiesBook } from './desk-properties.js';
import { MemoryStaffBook } from './desk-staff.js';
import { createSupportRouter } from './router.js';
import { SupportService } from './support-service.js';
import { MemoryLifecycleBook } from './ticket-lifecycle.js';
import { TEST_COMMENT_CAP } from './comment-cap.fixture.js';
import { MemoryFormsStore, RequestForms } from './request-forms.js';

const authConfig = {
  secret: 'a-support-request-forms-test-secret-long-enough-x',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const AGENT = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SESSION = '66666666-6666-4666-8666-666666666666';

async function ctx(userId: string, scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-forms' };
}

function desk(caps: { forms: number | null; fields: number | null } = { forms: 5, fields: 10 }) {
  const store = new MemoryFormsStore();
  const forms = new RequestForms(store, caps);
  const support = new SupportService(
    undefined,
    undefined,
    undefined,
    new MemoryStaffBook(),
    undefined,
    null,
    undefined,
    new MemoryGroupBook(),
    [],
    new MemoryPropertiesBook(),
    new MemoryLifecycleBook(),
    undefined,
    undefined,
    null,
    undefined,
    TEST_COMMENT_CAP,
  );
  const router = createSupportRouter(
    support,
    undefined,
    undefined,
    support,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    forms,
  );
  const as = async (userId: string, scopes = ['support:read', 'support:write']) => router.createCaller(await ctx(userId, scopes));
  const ticket = (userId = CUSTOMER, clientRequestId?: string) =>
    support.createTicket({
      userId,
      category: 'account',
      subject: 'Help',
      body: 'Help me please',
      ...(clientRequestId ? { clientRequestId } : {}),
    });
  const lead = async () => {
    if (!(await support.listStaff()).some((m) => m.userId === AGENT))
      await support.appointStaff({ actorId: AGENT, userId: AGENT, role: 'lead', idempotencyKey: 'lead' });
    return as(AGENT, ['support:read', 'support:write', 'support:ops']);
  };
  return { support, as, ticket, lead, store };
}

const R = 'TEST reason';
async function cardForm(lead: Awaited<ReturnType<ReturnType<typeof desk>['lead']>>) {
  await lead.defineRequestField({
    id: 'device',
    label: 'Device',
    kind: 'choice',
    options: [
      { value: 'phone', label: 'Phone' },
      { value: 'computer', label: 'Computer' },
    ],
    expectedRevision: 0,
    reason: R,
  });
  await lead.defineRequestField({
    id: 'system',
    label: 'System',
    kind: 'choice',
    options: [
      { value: 'ios', label: 'iOS' },
      { value: 'android', label: 'Android' },
      { value: 'windows', label: 'Windows' },
    ],
    parent: { fieldId: 'device', allowed: { phone: ['ios', 'android'], computer: ['windows'] } },
    expectedRevision: 0,
    reason: R,
  });
  await lead.defineRequestField({ id: 'model', label: 'Phone model', kind: 'text', expectedRevision: 0, reason: R });
  await lead.defineRequestField({ id: 'amount', label: 'Amount shown', kind: 'decimal', expectedRevision: 0, reason: R });
  return lead.defineRequestForm({
    id: 'device-problem',
    name: 'Device problem',
    fields: [
      { fieldId: 'device', required: true },
      { fieldId: 'system', required: true },
      { fieldId: 'model', required: true, showWhen: { fieldId: 'device', value: 'phone' } },
      { fieldId: 'amount', required: false },
    ],
    expectedRevision: 0,
    reason: R,
  });
}
const base = { category: 'other' as const, subject: 'TEST', body: 'TEST body' };

describe('request forms per type (SP-tickets-03)', () => {
  it('a blank cap refuses before anything is written, and an unknown kind is refused by name', async () => {
    const { lead, store } = desk({ forms: null, fields: null });
    const l = await lead();
    await expect(l.defineRequestField({ id: 'x', label: 'X', kind: 'text', expectedRevision: 0, reason: R })).rejects.toMatchObject({
      message: 'support.field_cap_unset',
    });
    await expect(
      l.defineRequestForm({ id: 'f', name: 'F', fields: [{ fieldId: 'x', required: false }], expectedRevision: 0, reason: R }),
    ).rejects.toMatchObject({ message: 'support.form_cap_unset' });
    expect(store.log).toHaveLength(0);
    const { lead: lead2 } = desk();
    await expect(
      (await lead2()).defineRequestField({ id: 'x', label: 'X', kind: 'money', expectedRevision: 0, reason: R }),
    ).rejects.toMatchObject({ message: 'support.field_kind_unsupported' });
  });

  it('a conditional field is accepted and required only while its controlling value is picked', async () => {
    const { lead, as } = desk();
    await cardForm(await lead());
    const me = await as(CUSTOMER);
    await expect(
      me.create({ ...base, form: { formId: 'device-problem', values: { device: 'phone', system: 'ios' } } }),
    ).rejects.toMatchObject({ message: 'support.field_value_invalid' });
    await expect(
      me.create({ ...base, form: { formId: 'device-problem', values: { device: 'computer', system: 'windows', model: 'X1' } } }),
    ).rejects.toMatchObject({ message: 'support.field_value_invalid' });
    const made = await me.create({
      ...base,
      clientRequestId: 'c1',
      form: { formId: 'device-problem', values: { device: 'phone', system: 'ios', model: 'P7', amount: '12.50' } },
    });
    expect(await me.ticketFieldValues({ ticketId: made.id })).toMatchObject({
      formId: 'device-problem',
      formRevision: 1,
      values: { model: 'P7', amount: '12.50' },
    });
    // A replay of the key answers the first request and keeps its first answers.
    const again = await me.create({
      ...base,
      clientRequestId: 'c1',
      form: { formId: 'device-problem', values: { device: 'phone', system: 'ios', model: 'P7', amount: '12.50' } },
    });
    expect(again.id).toBe(made.id);
    expect(await me.listMine({ limit: 10 })).toHaveLength(1);
  });

  it('a dependent field refuses a child its parent does not allow, and nothing is created', async () => {
    const { lead, as } = desk();
    await cardForm(await lead());
    const me = await as(CUSTOMER);
    await expect(
      me.create({ ...base, form: { formId: 'device-problem', values: { device: 'computer', system: 'ios' } } }),
    ).rejects.toMatchObject({ message: 'support.field_value_invalid' });
    await expect(
      me.create({
        ...base,
        form: { formId: 'device-problem', values: { device: 'phone', system: 'android', model: 'x', amount: '1 USD' } },
      }),
    ).rejects.toMatchObject({ message: 'support.field_value_invalid' });
    await expect(me.create({ ...base, form: { formId: 'nope', values: {} } })).rejects.toMatchObject({ message: 'support.form_unknown' });
    expect(await me.listMine({ limit: 10 })).toHaveLength(0);
  });

  it('a stale revision writes nothing, a retired form leaves the customer list, and the cap counts live forms only', async () => {
    const { lead, as } = desk({ forms: 1, fields: 10 });
    const l = await lead();
    const form = await cardForm(l);
    await expect(
      l.defineRequestForm({ id: 'other', name: 'Other', fields: [{ fieldId: 'device', required: true }], expectedRevision: 0, reason: R }),
    ).rejects.toMatchObject({ message: 'support.form_cap_reached' });
    await expect(l.defineRequestForm({ ...form, retired: true, expectedRevision: 0, reason: R })).rejects.toMatchObject({
      message: 'support.form_revision_stale',
    });
    await l.defineRequestForm({ id: form.id, name: form.name, fields: form.fields, retired: true, expectedRevision: 1, reason: R });
    expect((await (await as(CUSTOMER)).requestForms()).forms).toEqual([]);
    await l.defineRequestForm({
      id: 'other',
      name: 'Other',
      fields: [{ fieldId: 'device', required: true }],
      expectedRevision: 0,
      reason: R,
    });
  });

  it("a request's answers read as not found for anyone else, and only a lead defines", async () => {
    const { lead, as } = desk();
    await cardForm(await lead());
    const made = await (
      await as(CUSTOMER)
    ).create({ ...base, form: { formId: 'device-problem', values: { device: 'computer', system: 'windows' } } });
    await expect((await as(OTHER)).ticketFieldValues({ ticketId: made.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      (await as(OTHER, ['support:read', 'support:write', 'support:ops'])).defineRequestField({
        id: 'y',
        label: 'Y',
        kind: 'text',
        expectedRevision: 0,
        reason: R,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a field a live form or field uses cannot be retired or changed out from under it; a retired form need not fit', async () => {
    const { lead } = desk();
    const l = await lead();
    const form = await cardForm(l);
    const fields = (await l.requestFormsAll()).fields;
    const def = (id: string) => {
      const { revision, updatedAt: _at, ...rest } = fields.find((f) => f.id === id)!;
      return { ...rest, expectedRevision: revision, reason: R };
    };
    const invalid = { message: 'support.form_definition_invalid' };
    await expect(l.defineRequestField({ ...def('model'), retired: true })).rejects.toMatchObject(invalid);
    // Dropping the option a dependent field and a showWhen name is refused.
    await expect(l.defineRequestField({ ...def('device'), options: [{ value: 'computer', label: 'Computer' }] })).rejects.toMatchObject(
      invalid,
    );
    // Retire the form first; then the fields go, dependent before parent, and the form can still be retired again.
    await l.defineRequestForm({ id: form.id, name: form.name, fields: form.fields, retired: true, expectedRevision: 1, reason: R });
    await expect(l.defineRequestField({ ...def('device'), retired: true })).rejects.toMatchObject(invalid);
    for (const id of ['system', 'model', 'amount', 'device']) await l.defineRequestField({ ...def(id), retired: true });
    await l.defineRequestForm({ id: form.id, name: form.name, fields: form.fields, retired: true, expectedRevision: 2, reason: R });
  });

  it('a replay finds its ticket even after the form was retired, and keeps answers lost between the two writes', async () => {
    const { lead, as, store } = desk();
    const l = await lead();
    const form = await cardForm(l);
    const me = await as(CUSTOMER);
    const send = {
      ...base,
      clientRequestId: 'crash-1',
      form: { formId: 'device-problem', values: { device: 'computer', system: 'windows' } },
    };
    // The first try writes the ticket and then fails before the answers are kept.
    const record = store.recordValues.bind(store);
    store.recordValues = async () => {
      throw new Error('crash between writes');
    };
    await expect(me.create(send)).rejects.toBeTruthy();
    store.recordValues = record;
    const made = await me.create(send);
    expect((await me.ticketFieldValues({ ticketId: made.id }))?.values).toEqual({ device: 'computer', system: 'windows' });
    await l.defineRequestForm({ id: form.id, name: form.name, fields: form.fields, retired: true, expectedRevision: 1, reason: R });
    expect((await me.create(send)).id).toBe(made.id);
    expect(await me.listMine({ limit: 10 })).toHaveLength(1);
    // A new key on the retired form is refused.
    await expect(me.create({ ...send, clientRequestId: 'crash-2' })).rejects.toMatchObject({ message: 'support.form_unknown' });
  });

  it('the field cap is counted in the write itself, and text answers are kept trimmed', async () => {
    const { lead, as } = desk({ forms: 5, fields: 1 });
    const l = await lead();
    const results = await Promise.allSettled([
      l.defineRequestField({ id: 'a', label: 'A', kind: 'text', expectedRevision: 0, reason: R }),
      l.defineRequestField({ id: 'b', label: 'B', kind: 'text', expectedRevision: 0, reason: R }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const kept = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ id: string }>;
    await l.defineRequestForm({ id: 'f', name: 'F', fields: [{ fieldId: kept.value.id, required: true }], expectedRevision: 0, reason: R });
    const made = await (await as(CUSTOMER)).create({ ...base, form: { formId: 'f', values: { [kept.value.id]: '  P7  ' } } });
    expect((await (await as(CUSTOMER)).ticketFieldValues({ ticketId: made.id }))?.values).toEqual({ [kept.value.id]: 'P7' });
  });
});

import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryMacroBook, fillPlaceholders, placeholdersOf, type HandleSource } from './desk-macros.js';
import { MemoryStaffBook } from './desk-staff.js';
import { createSupportRouter } from './router.js';
import { SupportService } from './support-service.js';

/** SP-desk-02, J-support-public-10 #7: macros with placeholders, and signatures. */

const authConfig = {
  secret: 'a-support-desk-macros-test-secret-long-enough-xx',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const LEAD = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const SESSION = '66666666-6666-4666-8666-666666666666';

async function ctx(userId: string, scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-macros' };
}

const handles = (known: Record<string, string>): HandleSource => ({ handleOf: async (id) => known[id] ?? null });

async function desk(shortcodeMin: number | null = 2, names: Record<string, string> = { [CUSTOMER]: 'sq10abc', [LEAD]: 'lead_a' }) {
  const support = new SupportService(undefined, undefined, undefined, new MemoryStaffBook());
  const book = new MemoryMacroBook();
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
    undefined,
    book,
    handles(names),
    shortcodeMin,
  );
  const as = async (userId: string, scopes = ['support:ops', 'support:read', 'support:write']) =>
    router.createCaller(await ctx(userId, scopes));
  const lead = await as(LEAD);
  await lead.staffAppoint({ userId: LEAD, role: 'lead', idempotencyKey: 'appoint-lead-macros' });
  await lead.staffAppoint({ userId: AGENT, role: 'agent', idempotencyKey: 'appoint-agent-macros' });
  const ticket = await support.createTicket({ userId: CUSTOMER, category: 'account', subject: 'Macro', body: 'Help me please' });
  return { book, lead, agent: await as(AGENT), ticket, support };
}

const hello = { title: 'Hello', shortcode: 'hi', body: 'Hi {{requester.name}}, about {{ticket.id}}. {{agent.name}}', shared: true };

describe('macros (SP-desk-02)', () => {
  it('fills the placeholders for the request, records the use once, and sends nothing', async () => {
    const { book, lead, ticket } = await desk();
    const macro = await lead.macrosSave(hello);
    expect(macro.placeholders).toEqual(['requester.name', 'ticket.id', 'agent.name']);
    const applied = await lead.macrosApply({ ticketId: ticket.id, macroId: macro.id, clientRequestId: 'apply-0001' });
    expect(applied.draft).toBe(`Hi sq10abc, about ${ticket.id}. lead_a`);
    await lead.macrosApply({ ticketId: ticket.id, macroId: macro.id, clientRequestId: 'apply-0001' });
    expect(book.useCount(macro.id)).toBe(1);
    expect(await lead.listComments({ ticketId: ticket.id, limit: 10 })).toHaveLength(0);
  });

  it('refuses a placeholder outside the list, a taken shortcode, an agent sharing, and a blank shortcode rule', async () => {
    const { lead, agent } = await desk();
    await expect(lead.macrosSave({ ...hello, body: 'Your balance is {{account.balance}}' })).rejects.toMatchObject({
      message: 'support.macro_placeholder_unknown',
    });
    await lead.macrosSave(hello);
    await expect(lead.macrosSave(hello)).rejects.toMatchObject({ code: 'CONFLICT', message: 'support.shortcode_taken' });
    await expect(agent.macrosSave(hello)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await agent.macrosSave({ ...hello, shared: false })).toMatchObject({ shared: false, shortcode: 'hi' });
    await expect(lead.macrosSave({ ...hello, shortcode: 'h' })).rejects.toMatchObject({ message: 'support.shortcode_invalid' });
    const unset = await desk(null);
    await expect(unset.lead.macrosSave(hello)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.shortcode_rule_unset SUPPORT_MACRO_SHORTCODE_MIN',
    });
  });

  it('refuses to apply when a name cannot be read, rather than leave it blank', async () => {
    const { lead, ticket } = await desk(2, {});
    const macro = await lead.macrosSave(hello);
    await expect(lead.macrosApply({ ticketId: ticket.id, macroId: macro.id, clientRequestId: 'apply-0002' })).rejects.toMatchObject({
      message: 'support.macro_placeholder_unread',
    });
  });

  it("an agent sees shared macros and their own, not another agent's personal ones", async () => {
    const { lead, agent } = await desk();
    await lead.macrosSave({ ...hello, shared: false, shortcode: 'mine' });
    await lead.macrosSave(hello);
    expect((await agent.macrosList()).macros.map((m) => m.shortcode)).toEqual(['hi']);
  });

  it('keeps one signature per person, and clears it with null or blank', async () => {
    const { lead } = await desk();
    expect(await lead.staffSignature()).toEqual({ signature: null });
    expect(await lead.staffSetSignature({ signature: '  Lead A, support  ' })).toEqual({ signature: 'Lead A, support' });
    expect(await lead.staffSignature()).toEqual({ signature: 'Lead A, support' });
    expect(await lead.staffSetSignature({ signature: ' ' })).toEqual({ signature: null });
  });

  it('parses placeholders and fills them exactly', () => {
    expect(placeholdersOf('{{ ticket.id }} and {{ticket.id}}')).toEqual(['ticket.id']);
    expect(fillPlaceholders('#{{ ticket.id }}', { 'requester.name': null, 'ticket.id': 'T1', 'agent.name': null })).toBe('#T1');
  });
});

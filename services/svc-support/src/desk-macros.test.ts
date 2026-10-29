import { describe, expect, it } from 'vitest';
import type { SupportTicket } from '@intafaced/contracts';
import { DeskMacros, MemoryMacroBook } from './desk-macros.js';
import type { StaffMember } from './desk-staff.js';
import { SupportError } from './support-service.js';

/** SP-desk-02: a lead writes macros at a revision; any agent applies one to a request they may see; nothing is sent. */

const LEAD = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';
const LEAD_2 = '77777777-7777-4777-8777-777777777777';
const TICKET = '55555555-5555-4555-8555-555555555555';
const R = 'TEST reason';

function staff(userId: string, role: StaffMember['role']): StaffMember {
  return {
    userId,
    role,
    appointedBy: LEAD,
    appointedAt: '2026-10-29T00:00:00.000Z',
    availability: 'online',
    availabilitySetAt: null,
    lastHeartbeatAt: null,
  } as StaffMember;
}

function desk(shortcodeMin: number | null = 2) {
  const reads: string[] = [];
  const book = new MemoryMacroBook();
  const macros = new DeskMacros(
    book,
    {
      listStaff: async () => [staff(LEAD, 'lead'), staff(LEAD_2, 'lead'), staff(AGENT, 'agent')],
      getTicket: async ({ ticketId, asOperator }) => {
        reads.push(`${ticketId}:${asOperator}`);
        if (ticketId !== TICKET) throw new SupportError('not found', 'support.not_found');
        return { id: TICKET, subject: 'Card declined', category: 'account' } as SupportTicket;
      },
    },
    shortcodeMin,
    () => '2026-10-29T12:00:00.000Z',
  );
  return { book, macros, reads };
}

const card = {
  title: 'Card',
  shortcode: 'card',
  folder: 'Cards',
  body: 'About {{ ticket.id }}. Hi {{requester.name}}, {{agent.name}} here.',
  expectedRevision: 0,
  reason: R,
};

describe('DeskMacros', () => {
  it('only a lead saves a macro; an agent is refused and nothing is written', async () => {
    const { macros } = desk();
    await expect(macros.save(AGENT, card)).rejects.toMatchObject({ code: 'support.not_lead' });
    expect(await macros.list()).toEqual([]);
    const saved = await macros.save(LEAD, card);
    expect(saved).toMatchObject({ title: 'Card', shortcode: 'card', folder: 'Cards', revision: 1, updatedBy: LEAD });
    expect(await macros.list()).toEqual([saved]);
  });

  it('refuses a placeholder no request can fill, and writes nothing', async () => {
    const { macros } = desk();
    await expect(macros.save(LEAD, { ...card, body: 'Hi {{ticket.subject}}' })).rejects.toMatchObject({
      code: 'support.macro_placeholder_unknown',
    });
    expect(await macros.list()).toEqual([]);
  });

  it('a blank shortcode minimum refuses every save; a shortcode under it refuses; neither writes', async () => {
    const unset = desk(null);
    await expect(unset.macros.save(LEAD, card)).rejects.toMatchObject({ code: 'support.shortcode_rule_unset' });
    expect(await unset.macros.list()).toEqual([]);
    const { macros } = desk(3);
    await expect(macros.save(LEAD, { ...card, shortcode: 'ca' })).rejects.toMatchObject({ code: 'support.shortcode_too_short' });
    expect(await macros.list()).toEqual([]);
    expect((await macros.save(LEAD, { ...card, shortcode: 'car' })).shortcode).toBe('car');
  });

  it('a stale revision and a taken shortcode write nothing; a retried save answers the first', async () => {
    const { macros } = desk();
    const first = await macros.save(LEAD, card);
    expect(await macros.save(LEAD, card)).toEqual(first);
    // Another lead sending the same text is not a retry of the first lead's write.
    await expect(macros.save(LEAD_2, card)).rejects.toMatchObject({ code: 'support.shortcode_taken' });
    await expect(macros.save(LEAD, { ...card, body: 'Other' })).rejects.toMatchObject({ code: 'support.shortcode_taken' });
    const second = await macros.save(LEAD, { ...card, macroId: first.id, body: 'Changed', expectedRevision: 1 });
    expect(second.revision).toBe(2);
    await expect(macros.save(LEAD, { ...card, macroId: first.id, body: 'Again', expectedRevision: 1 })).rejects.toMatchObject({
      code: 'support.macro_revision_stale',
    });
    // The title is not the key: another macro may share it, never the shortcode.
    const other = await macros.save(LEAD, { ...card, shortcode: 'other' });
    await expect(macros.save(LEAD, { ...card, macroId: other.id, expectedRevision: 1 })).rejects.toMatchObject({
      code: 'support.shortcode_taken',
    });
    await expect(
      macros.save(LEAD, { ...card, macroId: '66666666-6666-4666-8666-666666666666', expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: 'support.macro_not_found' });
    expect((await macros.list()).map((m) => `${m.shortcode}@${m.revision}:${m.body}`).sort()).toEqual([
      'card@2:Changed',
      'other@1:' + card.body,
    ]);
  });

  it('applying fills what the desk knows of the request, leaves the names it holds none of unfilled, and writes nothing', async () => {
    const { macros, reads } = desk();
    const saved = await macros.save(LEAD, card);
    const before = await macros.list();
    expect(await macros.apply(AGENT, { ticketId: TICKET, macroId: saved.id })).toEqual({
      macroId: saved.id,
      revision: 1,
      text: `About ${TICKET}. Hi {{requester.name}}, {{agent.name}} here.`,
      unfilled: ['requester.name', 'agent.name'],
    });
    expect(reads).toEqual([`${TICKET}:true`]);
    expect(await macros.list()).toEqual(before);
  });

  it('a request out of reach and a missing macro are refused by their codes', async () => {
    const { macros } = desk();
    const saved = await macros.save(LEAD, card);
    await expect(macros.apply(AGENT, { ticketId: '77777777-7777-4777-8777-777777777777', macroId: saved.id })).rejects.toMatchObject({
      code: 'support.not_found',
    });
    await expect(macros.apply(AGENT, { ticketId: TICKET, macroId: '66666666-6666-4666-8666-666666666666' })).rejects.toMatchObject({
      code: 'support.macro_not_found',
    });
  });

  it('each agent writes only their own signature, at a revision; a retry answers, a stale read refuses', async () => {
    const { macros } = desk();
    expect(await macros.signature(AGENT)).toEqual({ signature: null, revision: 0 });
    const set = await macros.setSignature(AGENT, { signature: 'Sam, support', expectedRevision: 0 });
    expect(set).toEqual({ signature: 'Sam, support', revision: 1 });
    expect(await macros.setSignature(AGENT, { signature: 'Sam, support', expectedRevision: 0 })).toEqual(set);
    await expect(macros.setSignature(AGENT, { signature: 'Sam', expectedRevision: 0 })).rejects.toMatchObject({
      code: 'support.macro_revision_stale',
    });
    expect(await macros.signature(AGENT)).toEqual(set);
    expect(await macros.signature(LEAD)).toEqual({ signature: null, revision: 0 });
    // A placeholder in a signature would never be filled, so every reply carrying it would be refused: refused here.
    await expect(macros.setSignature(AGENT, { signature: '{{agent.name}}, support', expectedRevision: 1 })).rejects.toMatchObject({
      code: 'support.macro_placeholder_blank',
    });
    expect(await macros.signature(AGENT)).toEqual(set);
  });
});

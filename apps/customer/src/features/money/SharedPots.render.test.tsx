// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Space } from './client';
import type { ActionSpec } from './components';

/**
 * Shared pots on the Spaces page (BK-acct-09, J-bank-07 #6): blank bank values said in words, an invite to the person
 * with its lifetime or that it ended, a pot shared with them with its owner, role, balance and people, a pot they share
 * with its open invites, the card linked to a pot that its holders can freeze, and the log naming who did what.
 */

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
const POT = '11111111-1111-4111-8111-111111111111';
const MINE = '22222222-2222-4222-8222-222222222222';
const INVITE = '33333333-3333-4333-8333-333333333333';
let reads: Record<string, { status: 'ready'; data: unknown }>;
vi.mock('./components', async (original) => {
  const real = await original<typeof import('./components')>();
  return {
    ...real,
    useBankRead: (procedure: string) => ({ resource: reads[procedure] ?? { status: 'loading' }, reload: () => undefined }),
  };
});
import { SharedPots } from './SharedPots';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
let opened: ActionSpec[] = [];

const person = (userId: string, handle: string | null) => ({ userId, handle });
const spaces = [
  { id: 'main-usdt', name: 'Main', assetId: 'USDT', kind: 'primary', balance: '20' },
  { id: MINE, name: 'Holiday TEST', assetId: 'USDT', kind: 'named', balance: '10' },
] as unknown as Space[];

beforeEach(() => {
  opened = [];
  reads = {
    'sharedPots.list': {
      status: 'ready',
      data: {
        terms: { inviteMinutes: 2, peopleCap: 2 },
        owned: [
          {
            pot: { id: MINE, name: 'Holiday TEST', assetId: 'USDT' },
            card: null,
            members: [{ ...person('u-pia', 'Pia_Partner'), role: 'contributor', joinedAt: '2026-10-24T10:00:00Z' }],
            invites: [
              {
                inviteId: 'i-old',
                spaceId: MINE,
                role: 'viewer',
                createdAt: '2026-10-24T09:00:00Z',
                expiresAt: '2026-10-24T09:02:00Z',
                expired: true,
                invitee: person('u-vic', 'Vic_Viewer'),
              },
            ],
          },
        ],
        shared: [
          {
            pot: { id: POT, name: 'Flat TEST', assetId: 'USDT', balance: '15' },
            card: { cardId: 'c-olga', panTail: '4242', status: 'active', frozenBy: null },
            owner: person('u-olga', 'Olga_Owner'),
            role: 'viewer',
            members: [{ ...person('u-me', 'Me_Here'), role: 'viewer', joinedAt: '2026-10-24T10:00:00Z' }],
          },
        ],
        invites: [
          {
            inviteId: INVITE,
            spaceId: POT,
            role: 'contributor',
            createdAt: '2026-10-24T09:00:00Z',
            expiresAt: '2026-10-24T09:02:00Z',
            expired: true,
            pot: { name: 'Flat TEST', assetId: 'USDT' },
            owner: person('u-olga', 'Olga_Owner'),
          },
        ],
      },
    },
    'cards.list': {
      status: 'ready',
      data: [
        { id: 'c-open', panTail: '1111', assetId: 'USDT', status: 'frozen' },
        { id: 'c-shut', panTail: '2222', assetId: 'USDT', status: 'closed' },
      ],
    },
    'sharedPots.activity': {
      status: 'ready',
      data: [
        {
          id: '3',
          kind: 'card_frozen',
          actor: person('u-pia', 'Pia_Partner'),
          subject: null,
          role: null,
          card: { cardId: 'c-olga', panTail: '4242' },
          at: '2026-10-24T11:00:00Z',
        },
        {
          id: '2',
          kind: 'joined',
          actor: person('u-pia', 'Pia_Partner'),
          subject: null,
          role: 'contributor',
          card: null,
          at: '2026-10-24T10:00:00Z',
        },
        {
          id: '1',
          kind: 'invited',
          actor: person('u-olga', 'Olga_Owner'),
          subject: person('u-gone', null),
          role: 'viewer',
          card: null,
          at: '2026-10-24T09:00:00Z',
        },
      ],
    },
  };
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
});

async function mount() {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<SharedPots spaces={spaces} open={(spec) => opened.push(spec)} />));
}

const button = (scope: Element, text: string) => [...scope.querySelectorAll('button')].find((b) => b.textContent === text)!;

describe('SharedPots', () => {
  it('says blank bank values in words', async () => {
    (reads['sharedPots.list']!.data as { terms: unknown }).terms = { inviteMinutes: null, peopleCap: 2 };
    await mount();
    const terms = host.querySelector('[data-testid="shared-pots-terms"]')!;
    expect(terms.getAttribute('data-state')).toBe('unset');
    expect(terms.textContent).toBe(
      'The bank has not decided how long an invite lasts or how many people can share a pot, so pots cannot be shared.',
    );
  });

  it('shows an invite that ended, and still offers to accept it so the bank can say why not', async () => {
    await mount();
    const invite = host.querySelector('[data-testid="shared-pot-invite"]')!;
    expect(invite.getAttribute('data-expired')).toBe('true');
    expect(invite.textContent).toContain('@Olga_Owner invites you to Flat TEST (USDT) as a contributor.');
    expect(invite.textContent).toContain('This invite ended at');
    act(() => button(invite, 'Accept').click());
    expect(opened[0]).toMatchObject({ procedure: 'sharedPots.accept' });
    expect(opened[0]!.input({}, 'req')).toEqual({ inviteId: INVITE });
  });

  it('a pot shared with the person: owner, role, the bank’s balance, and adding money is a transfer from their own account', async () => {
    await mount();
    const pot = host.querySelector('[data-testid="shared-pot-shared"]')!;
    expect(pot.getAttribute('data-role')).toBe('viewer');
    expect(pot.textContent).toContain('Owner: @Olga_Owner · You are: viewer');
    expect(pot.querySelector('[data-testid="shared-pot-balance"]')!.textContent).toBe('15 USDT');
    act(() => button(pot, 'Add money').click());
    expect(opened[0]).toMatchObject({ procedure: 'transfers.create' });
    expect(opened[0]!.input({ amount: '5' }, 'req-1')).toEqual({
      transferId: 'req-1',
      fromSpaceId: 'main-usdt',
      toSpaceId: POT,
      amount: '5',
    });
  });

  it('a pot the person shares lists its people and open invites, and the log names who acted', async () => {
    await mount();
    const mine = host.querySelector('[data-testid="shared-pot-owned"]')!;
    expect(mine.querySelector('[data-testid="shared-pot-member"]')!.textContent).toContain('@Pia_Partner, contributor');
    const open = mine.querySelector('[data-testid="shared-pot-open-invite"]')!;
    expect(open.textContent).toContain('@Vic_Viewer, viewer: invite ended at');
    act(() => button(open, 'Cancel invite').click());
    expect(opened[0]).toMatchObject({ procedure: 'sharedPots.cancelInvite' });
    expect(opened[0]!.input({}, 'req')).toEqual({ inviteId: 'i-old' });
    // The log is read only once it is opened.
    expect(mine.querySelector('[data-testid="shared-pot-log-entry"]')).toBeNull();
    const details = mine.querySelector('details')!;
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    const log = [...mine.querySelectorAll('[data-testid="shared-pot-log-entry"]')].map((el) => el.textContent);
    expect(log[0]).toMatch(/^@Pia_Partner froze the card •••• 4242, /);
    expect(log[1]).toMatch(/^@Pia_Partner joined as a contributor, /);
    expect(log[2]).toMatch(/^@Olga_Owner invited someone no longer on the app as a viewer, /);
  });

  it('sharing sends a handle or an email as the bank expects, under the request id', async () => {
    await mount();
    act(() => button(host, 'Share a pot').click());
    const spec = opened[0]!;
    expect(spec.procedure).toBe('sharedPots.invite');
    expect(spec.input({ spaceId: MINE, who: ' @Pia_Partner ', role: 'contributor' }, 'req-2')).toEqual({
      inviteId: 'req-2',
      spaceId: MINE,
      role: 'contributor',
      handle: '@Pia_Partner',
    });
    expect(spec.input({ spaceId: MINE, who: 'vic@example.com', role: 'viewer' }, 'req-3')).toMatchObject({ email: 'vic@example.com' });
    expect(spec.fields!.find((f) => f.name === 'who')!.validate!('not an address!')).toBe('Enter an @handle or an email address.');
  });

  it('a holder of a pot with a linked card can freeze it, and the freeze is the pot’s own ask', async () => {
    await mount();
    const pot = host.querySelector('[data-testid="shared-pot-shared"]')!;
    const card = pot.querySelector('[data-testid="shared-pot-card"]')!;
    expect(card.getAttribute('data-status')).toBe('active');
    expect(card.textContent).toBe('Card •••• 4242: active');
    act(() => button(pot, 'Freeze card').click());
    expect(opened[0]).toMatchObject({ procedure: 'sharedPots.freezeCard', title: 'Freeze the card •••• 4242' });
    expect(opened[0]!.notes).toEqual(['The card stops paying at once, and the pot’s log names you. Only @Olga_Owner can unfreeze it.']);
    expect(opened[0]!.input({}, 'req')).toEqual({ spaceId: POT });
  });

  it('a frozen card says who can lift it; the owner links one of their open cards, never a closed one', async () => {
    const list = reads['sharedPots.list']!.data as { shared: Array<{ card: unknown }> };
    list.shared[0]!.card = { cardId: 'c-olga', panTail: '4242', status: 'frozen', frozenBy: 'holder' };
    await mount();
    const pot = host.querySelector('[data-testid="shared-pot-shared"]')!;
    expect(pot.textContent).toContain('Only @Olga_Owner can unfreeze it.');
    expect(button(pot, 'Freeze card')).toBeUndefined();
    const mine = host.querySelector('[data-testid="shared-pot-owned"]')!;
    expect(mine.textContent).toContain('No card is linked.');
    act(() => button(mine, 'Link a card').click());
    expect(opened[0]).toMatchObject({ procedure: 'sharedPots.linkCard' });
    expect(opened[0]!.fields![0]!.options).toEqual([{ value: 'c-open', label: '•••• 1111 (USDT)' }]);
    expect(opened[0]!.input({ cardId: 'c-open' }, 'req')).toEqual({ spaceId: MINE, cardId: 'c-open' });
  });

  it('the owner of a pot whose card is frozen can unfreeze it through the card’s own door, or unlink it', async () => {
    const list = reads['sharedPots.list']!.data as { owned: Array<{ card: unknown }> };
    list.owned[0]!.card = { cardId: 'c-olga', panTail: '4242', status: 'frozen', frozenBy: 'holder' };
    await mount();
    const mine = host.querySelector('[data-testid="shared-pot-owned"]')!;
    act(() => button(mine, 'Unfreeze').click());
    expect(opened[0]).toMatchObject({ procedure: 'cards.setStatus' });
    expect(opened[0]!.input({}, 'req')).toEqual({ cardId: 'c-olga', status: 'active' });
    act(() => button(mine, 'Unlink card').click());
    expect(opened[1]).toMatchObject({ procedure: 'sharedPots.unlinkCard' });
    expect(opened[1]!.input({}, 'req')).toEqual({ spaceId: MINE });
  });

  it('a freeze the bank made says only the bank lifts it, offers no unfreeze, and the log names the bank', async () => {
    const list = reads['sharedPots.list']!.data as { owned: Array<{ card: unknown }>; shared: Array<{ card: unknown }> };
    list.owned[0]!.card = { cardId: 'c-olga', panTail: '4242', status: 'frozen', frozenBy: 'operator' };
    list.shared[0]!.card = { cardId: 'c-x', panTail: '9999', status: 'frozen', frozenBy: 'operator' };
    (reads['sharedPots.activity']!.data as Array<{ actor: unknown }>)[0]!.actor = person('bank', null);
    await mount();
    expect(host.querySelector('[data-testid="shared-pot-shared"]')!.textContent).toContain(
      'The bank froze this card. Only the bank can lift that freeze.',
    );
    const mine = host.querySelector('[data-testid="shared-pot-owned"]')!;
    expect(mine.textContent).toContain('The bank froze this card. Only the bank can lift that freeze.');
    expect(button(mine, 'Unfreeze')).toBeUndefined();
    const details = mine.querySelector('details')!;
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    expect(mine.querySelector('[data-testid="shared-pot-log-entry"]')!.textContent).toMatch(/^The bank froze the card •••• 4242, /);
  });
});

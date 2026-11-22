// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// TEST data only. Each test chooses what identity's `membership.offer` answers.
const USER = '12345678-1234-4234-8234-123456789abc';
const world = vi.hoisted(() => ({ answer: (() => Promise.resolve({})) as () => Promise<unknown>, asked: [] as string[] }));
// As the real client does, the answer is checked against the schema the component passes.
const api = {
  query: async (module: string, procedure: string, _input: unknown, schema: { safeParse: (v: unknown) => { success: boolean } }) => {
    world.asked.push(`${module}:${procedure}`);
    const answer = (await world.answer()) as { ok: boolean; data?: unknown };
    if (answer.ok && !schema.safeParse(answer.data).success)
      return { ok: false, reason: 'error', code: 'contract_mismatch', message: 'bad' };
    return answer;
  },
};
vi.mock('../session/session', () => ({ useSession: () => ({ userId: USER, api }) }));

import { Membership, membershipOfferSchema } from './Membership';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;

async function show(answer: unknown) {
  world.answer = () => Promise.resolve(answer);
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<Membership />));
  await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  world.asked = [];
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('Membership on Account (W-balances-04)', () => {
  it('blank owner config: says membership is not offered, with no tier, price or control', async () => {
    await show({ ok: true, data: { offered: false, code: 'identity.membership_not_offered' } });
    expect(world.asked).toEqual(['identity:membership.offer']);
    const panel = host.querySelector('[data-testid="membership"]')!;
    expect(panel.getAttribute('data-state')).toBe('not-offered');
    expect(panel.textContent).toContain('Membership is not offered');
    expect(host.querySelectorAll('button, form, [data-tier]')).toHaveLength(0);
  });

  it('published tiers: lists each with its price and perks as published, and the person has no tier', async () => {
    await show({
      ok: true,
      data: {
        offered: true,
        current: null,
        tiers: [
          { id: 'plus', name: 'TEST Plus', price: '9.99', assetId: 'USDT', periodDays: 30, perks: ['TEST perk one', 'TEST perk two'] },
          { id: 'bare', name: 'TEST Bare', price: '0.10', assetId: 'USDC', periodDays: 7, perks: [] },
        ],
      },
    });
    const panel = host.querySelector('[data-testid="membership"]')!;
    expect(panel.getAttribute('data-state')).toBe('offered');
    expect(panel.textContent).toContain('You have no membership tier.');
    const plus = host.querySelector('[data-tier="plus"]')!;
    expect(plus.textContent).toContain('TEST Plus');
    // The price is the owner's decimal string as published, never re-rounded.
    expect(plus.textContent).toContain('9.99 USDT every 30 days');
    expect([...plus.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['TEST perk one', 'TEST perk two']);
    expect(host.querySelector('[data-tier="bare"]')!.textContent).toContain('0.10 USDC every 7 days');
    expect(host.querySelector('[data-tier="bare"]')!.textContent).toContain('No perks are listed for this tier.');
    expect(panel.textContent).toContain('There is no way to buy a membership here.');
    expect(host.querySelectorAll('button, form')).toHaveLength(0);
  });

  it('identity unreachable: a refusal with retry, never a tier', async () => {
    await show({ ok: false, reason: 'error', code: 'identity.unavailable', message: 'down' });
    expect(host.querySelector('[data-testid="membership"]')).toBeNull();
    expect(host.querySelector('.failure')).not.toBeNull();
  });

  it('an answer that breaks the schema is a refusal, never a tier', async () => {
    await show({
      ok: true,
      data: {
        offered: true,
        current: null,
        tiers: [{ id: 'plus', name: 'TEST Plus', price: '9.99', assetId: 'USDT', periodDays: 30.5, perks: [] }],
      },
    });
    expect(host.querySelector('[data-tier]')).toBeNull();
    expect(host.querySelector('.failure')).not.toBeNull();
  });

  it('the schema refuses an answer that invents a current tier or drops the code', () => {
    expect(membershipOfferSchema.safeParse({ offered: true, tiers: [], current: { id: 'plus' } }).success).toBe(false);
    expect(membershipOfferSchema.safeParse({ offered: false }).success).toBe(false);
  });
});

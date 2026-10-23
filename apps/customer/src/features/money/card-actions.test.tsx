import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../session/session', async (original) => {
  const real = await original<typeof import('../session/session')>();
  return { ...real, useSession: () => ({ api: { canWrite: () => true }, userId: 'user-1' }) as never };
});
import { CardActions, CardReference } from './Cards';

vi.stubGlobal('location', { href: 'https://example.test/money/cards' });

const id = '7d0a2cd4-6a46-4f6b-9d8f-0d5f27ec7b11';
const card = {
  id,
  assetId: 'USDT',
  settlementAssetId: 'USDT',
  issuer: 'card-sim',
  simulated: true,
  panTail: '4242',
  status: 'active' as const,
  cashbackBps: 0,
  perAuthorizationLimit: '250.5',
  dailyLimit: null,
  monthlyLimit: null,
  cashLimit: null,
  online: true,
  contactless: true,
  atm: true,
  abroad: true,
  cardType: 'virtual' as const,
  shippingAddress: null,
};
const render = (props: Partial<Parameters<typeof CardActions>[0]>) =>
  renderToStaticMarkup(<CardActions card={card} programme={{ id: 'card-sim', simulated: true }} open={() => undefined} {...props} />);

describe('freeze and close on a card', () => {
  it('are offered on the labelled simulation record, so the page can keep its promise', () => {
    const html = render({});
    expect(html).toContain('>Freeze<');
    expect(html).toContain('>Close card<');
  });
  it('offer Unfreeze on a frozen card', () => {
    expect(render({ card: { ...card, status: 'frozen' } })).toContain('>Unfreeze<');
  });
  it('are not offered once the card is closed, and say it cannot be reopened', () => {
    const html = render({ card: { ...card, status: 'closed' } });
    expect(html).not.toContain('<button');
    expect(html).toContain('A closed card cannot be reopened');
  });
  it('are not offered when no card programme is connected, and say so', () => {
    const html = render({ programme: { id: 'none', simulated: false } });
    expect(html).not.toContain('<button');
    expect(html).toContain('needs a card programme, and none is connected here');
  });
});

describe('a card from another issuer', () => {
  it('is never frozen or closed under the simulation programme', () => {
    const html = render({ card: { ...card, simulated: false, issuer: 'live-x' } });
    expect(html).not.toContain('<button');
  });
  it('is never offered while the programme is still loading', () => {
    expect(render({ programme: undefined })).not.toContain('<button');
  });
});

describe('the card reference', () => {
  it('sits behind a Details disclosure, never in the open', () => {
    const html = renderToStaticMarkup(<CardReference id={id} />);
    expect(html).toMatch(/<details[^>]*><summary><span[^>]*>Details<\/span><\/summary>/);
    expect(html).toContain(id);
  });
});

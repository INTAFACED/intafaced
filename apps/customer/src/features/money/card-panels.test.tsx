import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../session/session', async (original) => {
  const real = await original<typeof import('../session/session')>();
  return { ...real, useSession: () => ({ api: { canWrite: () => true, query: async () => ({ ok: false }) }, userId: 'user-1' }) as never };
});
import { CardControlPanels, CardFace, OrderCard } from './CardPanels';

const card = {
  id: '7d0a2cd4-6a46-4f6b-9d8f-0d5f27ec7b11',
  assetId: 'USDT',
  settlementAssetId: 'USDT',
  issuer: 'issuer-x',
  simulated: false,
  panTail: '4242',
  status: 'active' as const,
  cashbackBps: 150,
  perAuthorizationLimit: '250.5',
  dailyLimit: '1000',
  monthlyLimit: null,
  cashLimit: '200.25',
  online: true,
  contactless: false,
  atm: true,
  abroad: false,
  cardType: 'virtual' as const,
  shippingAddress: null,
};
const open = () => undefined;

describe('card screens show every control and say why one is off', () => {
  it('draws only the facts the service returned', () => {
    const html = renderToStaticMarkup(<CardFace card={card} />);
    expect(html).toContain('•••• 4242');
    expect(html).toContain('Spends from USDT');
    expect(html).not.toMatch(/\b\d{4} \d{4} \d{4}\b/);
  });
  it('draws a physical card as physical', () => {
    expect(renderToStaticMarkup(<CardFace card={{ ...card, cardType: 'physical' }} />)).toContain('Physical');
    expect(renderToStaticMarkup(<CardFace card={card} />)).toContain('Virtual');
  });
  it('lays out limits, channels, details, PIN, wallets and cashback', () => {
    const html = renderToStaticMarkup(<CardControlPanels card={card} open={open} />);
    for (const heading of [
      'Spending limits',
      'Where this card works',
      'Card details',
      'PIN',
      'Phone wallets',
      'Cashback',
      'Lost or stolen?',
    ])
      expect(html).toContain(heading);
    expect(html).toContain('1.5%');
    expect(html.toLowerCase()).not.toContain('coming soon');
  });
  it('shows each limit exactly, and a cap that is not set as no limit rather than zero', () => {
    const html = renderToStaticMarkup(<CardControlPanels card={card} open={open} />);
    expect(html).toContain('250.5 USDT');
    expect(html).toContain('1,000 USDT');
    expect(html).toContain('200.25 USDT');
    expect(html).toMatch(/Per month<\/dt><dd><span[^>]*>No limit<\/span>/);
    expect(html).not.toMatch(/(?<![\d,.])0 USDT/);
  });
  it('lets the owner change limits and leaves the button live on an open card', () => {
    const html = renderToStaticMarkup(<CardControlPanels card={card} open={open} />);
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>Change limits<\/button>/);
  });
  it('shows the real state of every channel as a switch, in words as well as position', () => {
    const html = renderToStaticMarkup(<CardControlPanels card={card} open={open} />);
    expect(html.match(/role="switch"/g)).toHaveLength(4);
    const on = html.match(/aria-checked="true"/g) ?? [];
    const off = html.match(/aria-checked="false"/g) ?? [];
    expect(on).toHaveLength(2);
    expect(off).toHaveLength(2);
    expect(html).not.toContain('aria-checked="mixed"');
    // The state is written out beside each switch, not only drawn.
    expect(html.match(/>On</g)).toHaveLength(2);
    expect(html.match(/>Off</g)).toHaveLength(2);
  });
  it('turns the limit and channel controls off on a closed card and says why', () => {
    const html = renderToStaticMarkup(<CardControlPanels card={{ ...card, status: 'closed' }} open={open} />);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Change limits<\/button>/);
    expect(html).toContain('This card is closed, so its limits no longer apply.');
    expect(html).toContain('This card is closed, so these switches no longer apply.');
    expect((html.match(/role="switch"[^>]*disabled|disabled[^>]*role="switch"/g) ?? []).length).toBe(4);
  });
  it('keeps card details, PIN and wallets off with the real reason beside each', () => {
    const html = renderToStaticMarkup(<CardControlPanels card={card} open={open} />);
    for (const control of ['Show card number and security code', 'View PIN', 'Change PIN', 'Add to Apple Wallet', 'Add to Google Wallet'])
      expect(html).toMatch(new RegExp(`<button[^>]*disabled[^>]*>${control}</button>`));
    expect(html).toContain('held by the card issuer');
  });
  it('names the delivery address on a physical card', () => {
    const html = renderToStaticMarkup(
      <CardControlPanels
        card={{
          ...card,
          cardType: 'physical',
          shippingAddress: {
            name: 'Ada Lovelace',
            line1: '1 High St',
            line2: null,
            city: 'London',
            region: null,
            postalCode: 'N1 9GU',
            country: 'GB',
          },
        }}
        open={open}
      />,
    );
    expect(html).toContain('Ada Lovelace, 1 High St, London, N1 9GU, GB');
    expect(html).toContain('Physical card');
  });
  it('ordering is disabled with the first reason that applies', () => {
    const none = renderToStaticMarkup(<OrderCard open={open} programme={null} assets={[{ assetId: 'USDT', available: '1' }]} />);
    expect(none).toContain('No card issuer is connected');
    expect(none).toMatch(/<button[^>]*disabled[^>]*>Order a card<\/button>/);
    const test = renderToStaticMarkup(
      <OrderCard open={open} programme={{ id: 'card-sim', simulated: true }} assets={[{ assetId: 'USDT', available: '1' }]} />,
    );
    expect(test).toContain('test card programme');
    const poor = renderToStaticMarkup(<OrderCard open={open} programme={{ id: 'issuer-x', simulated: false }} assets={[]} />);
    expect(poor).toContain('needs a balance');
    const ready = renderToStaticMarkup(
      <OrderCard open={open} programme={{ id: 'issuer-x', simulated: false }} assets={[{ assetId: 'USDT', available: '1' }]} />,
    );
    expect(ready).not.toMatch(/<button[^>]*disabled[^>]*>Order a card<\/button>/);
  });
  it('offers virtual and physical as a choice, with virtual picked first and no address asked for', () => {
    const html = renderToStaticMarkup(
      <OrderCard open={open} programme={{ id: 'issuer-x', simulated: false }} assets={[{ assetId: 'USDT', available: '1' }]} />,
    );
    expect(html).toContain('role="radiogroup"');
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).toMatch(/name="card-type" checked="" value="virtual"/);
    expect(html).not.toContain('Delivery address');
    // The old line saying plastic cards cannot be ordered here is gone.
    expect(html).not.toContain('doesn’t collect a delivery address');
  });
});

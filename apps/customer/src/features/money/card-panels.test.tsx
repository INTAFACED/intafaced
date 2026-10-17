import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
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
};

describe('card screens show every control and say why one is off', () => {
  it('draws only the facts the service returned', () => {
    const html = renderToStaticMarkup(<CardFace card={card} />);
    expect(html).toContain('•••• 4242');
    expect(html).toContain('Spends from USDT');
    expect(html).not.toMatch(/\b\d{4} \d{4} \d{4}\b/);
  });
  it('lays out limits, channels, details, PIN, wallets and cashback with a reason on each disabled control', () => {
    const html = renderToStaticMarkup(<CardControlPanels card={card} />);
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
    for (const control of [
      'Change limits',
      'Show card number and security code',
      'View PIN',
      'Change PIN',
      'Add to Apple Wallet',
      'Add to Google Wallet',
    ])
      expect(html).toMatch(new RegExp(`<button[^>]*disabled[^>]*>${control}</button>`));
    expect(html.match(/role="switch"/g)).toHaveLength(4);
    expect(html).toContain('1.5%');
    expect(html).toContain('250.5 USDT');
    expect(html.toLowerCase()).not.toContain('coming soon');
  });
  it('ordering is disabled with the first reason that applies', () => {
    const none = renderToStaticMarkup(<OrderCard open={() => undefined} programme={null} assets={[{ assetId: 'USDT', available: '1' }]} />);
    expect(none).toContain('No card issuer is connected yet');
    expect(none).toMatch(/<button[^>]*disabled[^>]*>Order a card<\/button>/);
    const test = renderToStaticMarkup(
      <OrderCard open={() => undefined} programme={{ id: 'card-sim', simulated: true }} assets={[{ assetId: 'USDT', available: '1' }]} />,
    );
    expect(test).toContain('test card programme');
    const poor = renderToStaticMarkup(<OrderCard open={() => undefined} programme={{ id: 'issuer-x', simulated: false }} assets={[]} />);
    expect(poor).toContain('needs a balance');
    const ready = renderToStaticMarkup(
      <OrderCard open={() => undefined} programme={{ id: 'issuer-x', simulated: false }} assets={[{ assetId: 'USDT', available: '1' }]} />,
    );
    expect(ready).not.toMatch(/<button[^>]*disabled[^>]*>Order a card<\/button>/);
  });
});

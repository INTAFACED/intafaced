import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { SessionProvider } from '../session/session';
import {
  EmissionScheduleView,
  YieldHistoryView,
  emissionScheduleSchema,
  type EmissionScheduleRead,
  type MintedRead,
  type YieldHistoryRead,
} from './TokenEconomy';

const ready = <T,>(data: T) => ({ resource: { status: 'ready' as const, data }, reload: () => undefined });
const schedule = (data: EmissionScheduleRead, minted: MintedRead = { minted: null }) =>
  renderToStaticMarkup(
    <SessionProvider>
      <EmissionScheduleView schedule={ready(data)} minted={ready(minted)} />
    </SessionProvider>,
  );
const yields = (data: YieldHistoryRead) =>
  renderToStaticMarkup(
    <SessionProvider>
      <YieldHistoryView read={ready(data)} />
    </SessionProvider>,
  );
const unset = { params: null, epochs: null, missing: 'token_params', reason: 'token.params_unset' } as const;

describe('token economy: emission schedule', () => {
  it('with the schedule blank reads "not set" for every figure, shows no number, and states the minter rule', () => {
    const out = schedule(unset);
    const params = out.slice(out.indexOf('data-testid="emission-params"'), out.indexOf('data-testid="emission-blank"'));
    expect(params.match(/not set/g)).toHaveLength(3);
    expect(params.replace(/<[^>]*>/g, '')).not.toMatch(/\d/);
    expect(out).toContain('The emission schedule is not set');
    expect(out).toContain('No upcoming epoch reward can be shown.');
    expect(out).toContain('Minted to date: no epoch mint has closed.');
    expect(out).toContain('Only the token service mints');
  });

  it('a set schedule shows each epoch reward as served and marks where it halves', () => {
    const out = schedule(
      {
        params: { initialEpochReward: '100', halvingIntervalEpochs: 2, maxSupply: '1000' },
        epochs: [
          { epoch: 1, reward: '100' },
          { epoch: 2, reward: '50' },
          { epoch: 3, reward: '50' },
        ],
        missing: null,
        reason: null,
      },
      { minted: '150.5' },
    );
    expect(out).toContain('Every 2 epochs');
    expect(out).toContain('1,000');
    expect(out.match(/Halving starts/g)).toHaveLength(1);
    expect(out).toContain('Minted to date: 150.5.');
    expect(out).not.toContain('not set');
  });

  it('marks a halving on the first listed epoch from the interval, not from the row above', () => {
    const out = schedule({
      params: { initialEpochReward: '100', halvingIntervalEpochs: 2, maxSupply: '1000' },
      epochs: [
        { epoch: 4, reward: '25' },
        { epoch: 5, reward: '25' },
      ],
      missing: null,
      reason: null,
    });
    expect(out.match(/Halving starts/g)).toHaveLength(1);
    expect(out.indexOf('Halving starts')).toBeLessThan(out.indexOf('<td>5</td>'));
  });

  it('an unreadable schedule is not called blank, and a read that is neither set nor refused fails', () => {
    const out = schedule({ ...unset, reason: 'token.params_invalid' });
    expect(out).toContain('cannot be read');
    expect(out).not.toContain('not set');
    expect(emissionScheduleSchema.safeParse({ ...unset, reason: null }).success).toBe(false);
  });
});

describe('token economy: real yield', () => {
  it('lists each paid window as posted and never guesses an unread amount', () => {
    const out = yields({
      items: [
        { windowId: '2026-W43', amount: '12.5', assetId: 'ifc', ledgerTxId: 'tx-1', reason: null },
        { windowId: '2026-W44', amount: null, assetId: null, ledgerTxId: null, reason: 'ledger_tx_unread' },
      ],
      nextCursor: null,
    });
    expect(out).toContain('2026-W43');
    expect(out).toContain('12.5');
    expect(out).toContain('ifc');
    expect(out).toContain('posting not readable');
    expect(out).not.toContain('No real-yield payout');
    expect(out).not.toContain('Show older windows');
  });

  it('offers older windows when the service has a next page', () => {
    const out = renderToStaticMarkup(
      <SessionProvider>
        <YieldHistoryView
          read={ready({ items: [], nextCursor: 'cursor-1' })}
          more={{ busy: false, failure: null, more: () => undefined }}
        />
      </SessionProvider>,
    );
    expect(out).toContain('Show older windows');
  });

  it('with no payout says so beside the empty table', () => {
    const out = yields({ items: [], nextCursor: null });
    expect(out).toContain('aria-label="Payouts by window"');
    expect(out).toContain('No real-yield payout has been made to this account.');
  });
});

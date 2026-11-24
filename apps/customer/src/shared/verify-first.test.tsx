import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Server rendering has no browser store; read the stored preferences once.
vi.mock('./preferences', async (original) => {
  const real = await original<typeof import('./preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { createApiClient, type ApiResult } from './api';
import { ReadFailure } from './read-state';
import { FailureNote } from './failure-note';
import { FailureBox } from './record/record-parts';
import { Failure } from './ui';
import { shownCode } from './reference';
import { roomWords } from '../screens/trade/rooms/refusals';
import { roomRefusal } from '../screens/trade/copybots/refusals';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** The jurisdiction gate's reply to a person below the level a module needs, with the region it could not resolve. */
const GATE_REPLY = {
  error: {
    message: 'Verification tier "full" required for bank in XX',
    code: -32003,
    data: { code: 'FORBIDDEN', httpStatus: 403, intafacedCode: 'denied.kyc_required', cause: { code: 'denied.kyc_required' } },
  },
};

async function refusedBy(body: unknown, status = 403): Promise<Failed> {
  const api = createApiClient({ fetch: async () => new Response(JSON.stringify(body), { status }) });
  const result = await api.query('bank', 'spaces.list', {}, z.unknown());
  if (result.ok) throw new Error('expected a refusal');
  return result;
}

const PLACEHOLDERS = /\bXX\b|Verification tier|required for|denied\.kyc_required|tier\.insufficient|Access is restricted|Reference/;

describe('a person not yet verified reads one plain ask, never the gate', () => {
  it('the client words the gate refusal as the app, keeping its code only for support', async () => {
    const result = await refusedBy(GATE_REPLY);
    expect(result).toMatchObject({ reason: 'forbidden', code: 'denied.kyc_required', messageCopy: { key: 'verifyFirst' } });
    expect(result.message).toBe('Verify your identity to use this.');
  });

  it('words the gate sentence the same when it arrives under a bare code, and the tier guard too', async () => {
    const bare = await refusedBy({ error: 'Forbidden', message: 'Verification tier "basic" required for p2p in XX' });
    expect(bare.message).toBe('Verify your identity to use this.');
    const guard = await refusedBy({ error: { message: 'Verification tier "full" is required', data: { code: 'tier.insufficient' } } });
    expect(guard.message).toBe('Verify your identity to use this.');
  });

  it('leaves every other refusal in the service words', async () => {
    const other = await refusedBy({ error: 'Forbidden', message: 'Not served in DE' });
    expect(other.message).toBe('Not served in DE');
    expect(other.messageCopy).toBeUndefined();
  });

  it.each([
    ['ReadFailure', (r: Failed) => <ReadFailure result={r} retry={() => undefined} />],
    ['FailureNote', (r: Failed) => <FailureNote result={r} retry={() => undefined} />],
    ['FailureBox', (r: Failed) => <FailureBox result={r} retry={() => undefined} />],
    ['Failure', (r: Failed) => <Failure result={r} retry={() => undefined} />],
  ])('%s draws the ask with the way to Verification, no tier, region, code or Try again', async (_name, draw) => {
    const html = renderToStaticMarkup(draw(await refusedBy(GATE_REPLY)));
    expect(html).toContain('data-refusal="verify"');
    expect(html).toContain('Verify your identity first');
    expect(html).toContain('Verify your identity to use this.');
    expect(html).toContain('href="/verification"');
    expect(html).toContain('data-code="denied.kyc_required"');
    expect(html.replace(/data-code="[^"]*"/g, '')).not.toMatch(PLACEHOLDERS);
    expect(html).not.toContain('Try again');
  });

  it('no code line shows the verification codes', () => {
    expect(shownCode('denied.kyc_required')).toBeNull();
    expect(shownCode('tier.insufficient')).toBeNull();
    expect(shownCode('trade.price_band')).toBe('trade.price_band');
  });

  it('the trade and copy rooms say it the same way, with no code', async () => {
    const result = await refusedBy(GATE_REPLY);
    expect(roomWords({ code: 'denied.kyc_required', message: result.message })).toEqual({
      title: 'Verify your identity first',
      body: 'Verify your identity to use this.',
      verify: true,
    });
    expect(roomRefusal(result)).toMatchObject({ title: 'Verify your identity first', code: null });
  });
});

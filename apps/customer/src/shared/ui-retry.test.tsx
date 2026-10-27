import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store; read the stored preferences once.
vi.mock('./preferences', async (original) => {
  const real = await original<typeof import('./preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { canTryAgain, Failure } from './ui';
import type { ApiResult } from './api';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
const refusal = (over: Partial<Refusal>): Refusal => ({ ok: false, reason: 'error', message: 'No earn rates are configured', ...over });

describe('Try again is for trouble that can clear, not for a missing setting', () => {
  it('is offered when the network or the reply failed', () => {
    expect(canTryAgain(refusal({ reason: 'unreachable' }))).toBe(true);
    expect(canTryAgain(refusal({ reason: 'invalid_response' }))).toBe(true);
    expect(canTryAgain(refusal({ reason: 'aborted' }))).toBe(true);
    expect(canTryAgain(refusal({ reason: 'error', code: 'edge.upstream_unavailable' }))).toBe(true);
    expect(canTryAgain(refusal({ reason: 'error', code: 'trade.rate_limited' }))).toBe(true);
    expect(canTryAgain(refusal({ reason: 'unreachable', code: 'trade.market_status_unknown' }))).toBe(true);
    expect(canTryAgain(refusal({ reason: 'error', code: 'trade.lifecycle_authority_unavailable' }))).toBe(true);
  });
  it('is not offered when something is not switched on, allowed or listed', () => {
    expect(canTryAgain(refusal({ code: 'bank.earn_rate_unset' }))).toBe(false);
    expect(canTryAgain(refusal({ code: 'token.params_missing' }))).toBe(false);
    expect(canTryAgain(refusal({ code: 'trade.market_not_found' }))).toBe(false);
    expect(canTryAgain(refusal({ code: 'trade.price_band_unset' }))).toBe(false);
    expect(canTryAgain(refusal({ code: 'trade.open_orders_cap_unset' }))).toBe(false);
    expect(canTryAgain(refusal({ code: 'trade.fee_schedule_blank' }))).toBe(false);
    expect(canTryAgain(refusal({ code: 'denied.region_blocked' }))).toBe(false);
    expect(canTryAgain(refusal({ reason: 'not_mounted' }))).toBe(false);
    expect(canTryAgain(refusal({ reason: 'not_supported' }))).toBe(false);
    expect(canTryAgain(refusal({ reason: 'forbidden' }))).toBe(false);
  });
  it('is never offered when the outcome is unknown or sign-in is needed', () => {
    expect(canTryAgain(refusal({ reason: 'uncertain' }))).toBe(false);
    expect(canTryAgain(refusal({ reason: 'unauthorized' }))).toBe(false);
  });
  it('shows the reason in words and no button for a setting that is not configured', () => {
    const html = renderToStaticMarkup(<Failure result={refusal({ code: 'bank.earn_rate_unset' })} retry={() => undefined} />);
    expect(html).toContain('No earn rates are configured');
    expect(html).not.toContain('Try again');
  });
  it('still shows the button when the service could not be reached', () => {
    const html = renderToStaticMarkup(
      <Failure result={refusal({ reason: 'unreachable', message: 'The service could not be reached.' })} retry={() => undefined} />,
    );
    expect(html).toContain('Try again');
  });
  it('turns a raw refusal code into words, with no button when it needs a setting', () => {
    const html = renderToStaticMarkup(
      <Failure result={refusal({ message: 'token.params_missing', code: 'token.params_missing' })} retry={() => undefined} />,
    );
    expect(html).toContain('Not switched on');
    expect(html).not.toContain('token.params_missing');
    expect(html).not.toContain('Try again');
  });
  it('never prints a setting name that sits inside a sentence, and shows no button for it', () => {
    const html = renderToStaticMarkup(
      <Failure
        result={refusal({ message: 'Missing token_params.fee_discount_schedule', code: 'token.params_missing' })}
        retry={() => undefined}
      />,
    );
    expect(html).not.toContain('token_params');
    expect(html).not.toContain('fee_discount_schedule');
    expect(html).toContain('Not switched on');
    expect(html).not.toContain('Try again');
    // Ordinary text that looks like a setting name is left alone, with or without a code.
    const file = renderToStaticMarkup(<Failure result={refusal({ message: 'Upload id_card.png failed' })} retry={() => undefined} />);
    expect(file).toContain('Upload id_card.png failed');
    const plain = renderToStaticMarkup(<Failure result={refusal({ message: 'Version 1.2 is not available' })} retry={() => undefined} />);
    expect(plain).toContain('Version 1.2 is not available');
  });
  it('never says nothing was changed for a write whose outcome is unknown, even with a code', () => {
    const html = renderToStaticMarkup(
      <Failure
        result={refusal({ reason: 'uncertain', message: 'trade.matching_unavailable', code: 'trade.matching_unavailable' })}
        retry={() => undefined}
      />,
    );
    expect(html).toContain('Outcome not confirmed');
    expect(html).toContain('Check the original request before trying again');
    expect(html).not.toMatch(/nothing was changed|isn.t trading|paused/i);
    expect(html).not.toContain('trade.matching_unavailable');
    expect(html).not.toContain('Try again');
  });
  it('says a service the gateway reports as unwired is not connected here, with no button and no status code', () => {
    const result = refusal({ reason: 'unreachable', status: 502, code: 'edge.upstream_unwired', message: 'upstream unwired (502)' });
    expect(canTryAgain(result)).toBe(false);
    const html = renderToStaticMarkup(<Failure result={result} retry={() => undefined} />);
    expect(html).toContain('This service isn’t connected here.');
    expect(html).not.toMatch(/Try again|502|unwired/);
  });
  it('keeps the button for a service that did not answer, in plain words with no status code', async () => {
    const { createApiClient } = await import('./api');
    const api = createApiClient({
      fetch: async () => new Response(JSON.stringify({ code: 'edge.upstream_unavailable' }), { status: 502 }),
    });
    const result = await api.rest('/protocol/chain', (await import('zod')).z.unknown());
    if (result.ok) throw new Error('expected a refusal');
    expect(result.status).toBe(502);
    expect(result.message).toBe('The service didn’t answer. Try again in a moment.');
    const html = renderToStaticMarkup(<Failure result={result} retry={() => undefined} />);
    expect(html).toContain('Try again');
    expect(html).not.toMatch(/502|refused/);
  });
  it('says the gateway reported the service as unwired in plain words, whatever method was used', async () => {
    const { createApiClient } = await import('./api');
    const api = createApiClient({
      fetch: async () => new Response(JSON.stringify({ code: 'edge.upstream_unwired' }), { status: 503 }),
    });
    const result = await api.rest('/protocol/chain', (await import('zod')).z.unknown());
    if (result.ok) throw new Error('expected a refusal');
    expect(result.message).toBe('This service isn’t connected here.');
    expect(canTryAgain(result)).toBe(false);
  });
});

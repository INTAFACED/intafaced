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
    expect(html).toContain('Not set up yet');
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
    expect(html).toContain('Not set up yet');
    expect(html).not.toContain('Try again');
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
});

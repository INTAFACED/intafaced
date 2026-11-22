import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store; read the stored preferences once.
vi.mock('./preferences', async (original) => {
  const real = await original<typeof import('./preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { ReadFailure, ReadLoading, ReadView } from './read-state';
import type { ApiResult } from './api';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
const refusal = (over: Partial<Refusal>): Refusal => ({ ok: false, reason: 'error', message: 'No earn rates are configured', ...over });
const noop = () => undefined;

describe('a read drawn on the Volt kit says what the old kit said', () => {
  it('says a read is on its way, in a status', () => {
    const html = renderToStaticMarkup(<ReadLoading />);
    expect(html).toContain('role="status"');
    expect(html).toContain('Loading');
  });
  it('offers Try again for a service that could not be reached, and not for a missing setting', () => {
    const down = renderToStaticMarkup(<ReadFailure result={refusal({ reason: 'unreachable', message: 'Down' })} retry={noop} />);
    expect(down).toContain('Try again');
    expect(down).toContain('data-refusal="unreachable"');
    const unset = renderToStaticMarkup(<ReadFailure result={refusal({ code: 'bank.earn_rate_unset' })} retry={noop} />);
    expect(unset).toContain('No earn rates are configured');
    expect(unset).not.toContain('Try again');
  });
  it('turns a raw code into words', () => {
    const html = renderToStaticMarkup(<ReadFailure result={refusal({ message: 'token.params_missing', code: 'token.params_missing' })} />);
    expect(html).toContain('Not switched on');
    expect(html).not.toContain('token.params_missing');
  });
  it('never calls a write whose outcome is unknown refused or unchanged', () => {
    const html = renderToStaticMarkup(
      <ReadFailure
        result={refusal({ reason: 'uncertain', message: 'trade.matching_unavailable', code: 'trade.matching_unavailable' })}
        retry={noop}
      />,
    );
    expect(html).toContain('Outcome not confirmed');
    expect(html).toContain('role="alert"');
    expect(html).not.toMatch(/nothing was changed|isn.t trading|trade\.matching|Try again/i);
  });
  it('says a service that is not wired here is not connected, with no button', () => {
    const html = renderToStaticMarkup(
      <ReadFailure
        result={refusal({ reason: 'unreachable', code: 'edge.upstream_unwired', message: 'upstream unwired (502)' })}
        retry={noop}
      />,
    );
    expect(html).toContain('This service isn’t connected here.');
    expect(html).not.toMatch(/Try again|502|unwired/);
  });
  it('draws each of a read’s three states', () => {
    const child = (data: string) => <b>{data}</b>;
    expect(
      renderToStaticMarkup(
        <ReadView resource={{ status: 'loading' }} reload={noop}>
          {child}
        </ReadView>,
      ),
    ).toContain('Loading');
    expect(
      renderToStaticMarkup(
        <ReadView resource={{ status: 'failed', failure: refusal({ reason: 'unreachable', message: 'Down' }) }} reload={noop}>
          {child}
        </ReadView>,
      ),
    ).toContain('Try again');
    expect(
      renderToStaticMarkup(
        <ReadView resource={{ status: 'ready', data: 'here' }} reload={noop}>
          {child}
        </ReadView>,
      ),
    ).toBe('<b>here</b>');
  });
});

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ApiResult } from './api';
import { useFailureView, type FailureView } from './failure-view';
import { Failure } from './ui';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

function view(result: Failed): FailureView {
  let out: FailureView | null = null;
  function Probe() {
    out = useFailureView(result);
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return out!;
}
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
// Both draw the sign-in link back to where the person is.
vi.stubGlobal('location', { pathname: '/login', search: '' });

describe('useFailureView says what shared/ui Failure says, case by case', () => {
  const cases: [string, Failed][] = [
    ['a refusal in words', { ok: false, reason: 'error', message: 'Those details did not work' }],
    ['a raw code', { ok: false, reason: 'error', code: 'token.params_invalid', message: 'token.params_invalid' }],
    ['an uncertain write', { ok: false, reason: 'uncertain', message: 'gone' }],
    ['an uncertain raw code', { ok: false, reason: 'uncertain', code: 'x.y_z', message: 'x.y_z' }],
    ['signed out', { ok: false, reason: 'unauthorized', message: 'Sign in first' }],
    ['unreachable', { ok: false, reason: 'unreachable', message: 'No answer' }],
  ];
  for (const [name, result] of cases)
    it(name, () => {
      const v = view(result);
      const old = text(renderToStaticMarkup(<Failure result={result} />));
      expect(old).toContain(v.refusal.title);
      expect(old).toContain(v.refusal.body);
      if (v.refusal.action) expect(old).toContain(v.refusal.action.label);
      if (v.refusal.reference) expect(old).toContain(v.refusal.reference);
      expect(renderToStaticMarkup(<Failure result={result} />)).toContain(`role="${v.role}"`);
    });

  it('offers Try again exactly where Failure does', () => {
    expect(view({ ok: false, reason: 'unreachable', message: 'No answer' }).retryable).toBe(true);
    expect(view({ ok: false, reason: 'uncertain', message: 'gone' }).retryable).toBe(false);
    expect(view({ ok: false, reason: 'unauthorized', message: 'x' }).retryable).toBe(false);
  });
});

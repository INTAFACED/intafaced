// @vitest-environment happy-dom
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderPart } from '../../app/render-record/harness';
import { publishedCopy } from '../../shared/copy';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => void vi.useFakeTimers({ toFake: ['Date'] }));
afterAll(() => void vi.useRealTimers());

const body = publishedCopy('support.kb.account_access.body', 'en') ?? '';

describe('the "Sign-in and account access" help article', () => {
  it('points at the control that exists on the sign-in screen, by its real name', { timeout: 120_000 }, async () => {
    const label = /“([^”]+)”/.exec(body)?.[1];
    expect(label).toBe('Recover account access');
    // The sign-in screen as a person sees it, signed out.
    const page = document.createElement('div');
    page.innerHTML = await renderPart({ name: '/login', route: '/login' });
    const control = [...page.querySelectorAll('a')].find((link) => link.textContent === label);
    expect(control, `the sign-in screen draws "${label}"`).toBeDefined();
    expect(control!.getAttribute('href')?.split('?')[0]).toBe('/findPwd');
  });

  it('describes the reset page as it stands and promises nothing that is not built', () => {
    expect(body).not.toContain('use account recovery');
    expect(body).toContain('password reset page');
    expect(body).toContain('If that page says reset is not switched on, write to support');
    expect(body).toContain('Support never asks for your password or recovery codes in chat.');
    for (const promise of ['instantly', 'automatically', 'within minutes', 'we will email you'])
      expect(body.toLowerCase()).not.toContain(promise);
  });
});

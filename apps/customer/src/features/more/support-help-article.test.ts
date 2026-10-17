import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { publishedCopy } from '../../shared/copy';

const body = publishedCopy('support.kb.account_access.body', 'en') ?? '';

describe('the "Sign-in and account access" help article', () => {
  it('points at the control that exists on the sign-in screen, by its real name', () => {
    const signIn = readFileSync(new URL('../public/AuthForm.tsx', import.meta.url), 'utf8');
    const label = /“([^”]+)”/.exec(body)?.[1];
    expect(label).toBe('Recover account access');
    expect(signIn).toContain(`p('${label}')`);
    expect(signIn).toContain("'/findPwd'");
  });

  it('describes the reset page as it stands and promises nothing that is not built', () => {
    expect(body).not.toContain('use account recovery');
    expect(body).toContain('password reset page');
    expect(body).toContain('If that page says reset is not switched on yet, write to support');
    expect(body).toContain('Support never asks for your password or recovery codes in chat.');
    for (const promise of ['instantly', 'automatically', 'within minutes', 'we will email you'])
      expect(body.toLowerCase()).not.toContain(promise);
  });
});

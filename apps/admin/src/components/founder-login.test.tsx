import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FounderLogin, loginNotice } from './founder-login';

describe('sign-in additions', () => {
  it('links to the forgotten-password page, quietly', () => {
    const html = renderToStaticMarkup(<FounderLogin />);
    expect(html).toMatch(/<a [^>]*href="\/reset"[^>]*>Forgot password\?<\/a>/);
  });
  it('shows the password-changed line only for ?changed=1', () => {
    expect(loginNotice('?changed=1')).toBe('Password changed. Sign in with your new password.');
    expect(loginNotice('?changed=2')).toBe('');
    expect(loginNotice('?enquiry=abc')).toBe('');
    expect(loginNotice('')).toBe('');
  });
  it('renders no notice before the page has mounted', () => {
    expect(renderToStaticMarkup(<FounderLogin />)).not.toContain('Password changed');
  });
});

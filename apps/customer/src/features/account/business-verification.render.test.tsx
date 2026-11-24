// @vitest-environment happy-dom
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BusinessVerification } from './BusinessVerification';

describe('/identbusiness copy and card layout (#6177)', () => {
  it('keeps its note inside a card and drops "Verification is decided by the verification service"', () => {
    const html = renderToString(<BusinessVerification />);
    expect(html).not.toContain('verification service');
    const host = document.createElement('div');
    host.innerHTML = html;
    const page = host.querySelector('[data-testid="page"]')!;
    const looseParagraphs = Array.from(page.children).filter((el) => el.tagName === 'P');
    expect(looseParagraphs).toHaveLength(0);
  });
});

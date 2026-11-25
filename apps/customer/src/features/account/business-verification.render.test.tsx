// @vitest-environment happy-dom
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BusinessVerification } from './BusinessVerification';

describe('/identbusiness copy and card layout (#6177)', () => {
  it('keeps its note inside the step region and drops "Verification is decided by the verification service"', () => {
    const html = renderToString(<BusinessVerification />);
    expect(html).not.toContain('verification service');
    const host = document.createElement('div');
    host.innerHTML = html;
    const step = host.querySelector('[data-region="step"]')!;
    expect(step.textContent).toContain('If a step is unavailable for your account or region, that page explains why.');
    const room = host.querySelector('.lt-room')!;
    const looseParagraphs = Array.from(room.children).filter((el) => el.tagName === 'P');
    expect(looseParagraphs).toHaveLength(0);
  });
});

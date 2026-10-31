import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ServiceOffNotice } from './index.js';

describe('the kit service-off notice (HM-shell-03)', () => {
  it('draws the sentence, then its allowlist code, with the code in data-not-connected', () => {
    const html = renderToString(
      <ServiceOffNotice code="vendor.push" sentence="Registering this device needs a push delivery gateway." role="status" />,
    );
    expect(html).toContain('data-not-connected="vendor.push"');
    expect(html).toContain('role="status"');
    expect(html.replace(/<[^>]+>/g, '')).toBe('Registering this device needs a push delivery gateway. vendor.push');
  });

  it('takes only allowlist codes, so an own gap cannot borrow it', () => {
    // @ts-expect-error: our own missing back end is not on the allowlist.
    const own = <ServiceOffNotice code="svc.notify" sentence="Sending" />;
    expect(own).toBeTruthy();
  });
});

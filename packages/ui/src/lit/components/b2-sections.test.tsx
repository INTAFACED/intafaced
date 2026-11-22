import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SectionTabs } from './b2-basics.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe('SectionTabs', () => {
  it('draws one button per section in a named group, the open one pressed and no other', () => {
    const out = html(
      <SectionTabs
        label="Wallet sections"
        items={[
          { value: 'send', label: 'Send' },
          { value: 'scan', label: 'Scan' },
        ]}
        value="scan"
        onChange={() => undefined}
      />,
    );
    expect(out).toContain('role="group" aria-label="Wallet sections"');
    expect(out).toContain('<button type="button" class="lt-tab" aria-pressed="false">Send</button>');
    expect(out).toContain('<button type="button" class="lt-tab" aria-pressed="true">Scan</button>');
  });
});
